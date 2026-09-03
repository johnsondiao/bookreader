/**
 * TTS 总调度器 —— MiniMax 在线整章合成（speech-2.8-turbo, T2A v2 同步）+ 本地缓存播放。
 *
 * 工作模式：
 *   - 段落带类型（text/note），正文用 voiceKey，注释段用 noteVoiceKey
 *   - 相同音色的连续段落合并成一个合成块，整块 T2A v2 同步合成 mp3，
 *     减少接口调用次数、省成本、音色切换自然
 *   - 每段合成结果（PlaySegment blob 序列）按 bookId:chapterId:voiceKey_noteVoiceKey
 *     为维度缓存，textHash 校验；已缓存直接播放，绝不重复合成
 *   - 播放统一按「段落全局字符比例」估算当前段，回调高亮
 */
import { Capacitor } from '@capacitor/core'
import { agentLog } from './agentLog'
import { synthesizeChunk, type SynthProgress } from './minimaxTts'
import { addSynthChars, checkBudget } from './costTracker'
import { getClip, hashText, putClip, type AudioChunk, type ChapterAudio, type ChapterFileMeta } from './audioCache'
import {
  DEFAULT_VOICE_EN,
  DEFAULT_VOICE_NOTE,
  DEFAULT_VOICE_ZH,
  getVoice,
  VOICE_CATALOG,
  voicesForLang,
  type VoiceDef,
} from './ttsVoices'
import type { Paragraph, ParagraphKind } from './chapterParser'
import { isSentenceEnd } from './chapterParser'

export type TtsStatus = 'idle' | 'speaking' | 'paused' | 'loading'

export type TtsVoiceRef = {
  index: number
  lang: string
  name: string
  key: string
  gender?: string
}

export type TtsProgress = {
  stage: string
  progress: number
  message: string
}

export interface PlayChapterOpts {
  bookId: string
  bookTitle: string
  chapterId: string
  chapterTitle: string
  /** 章节段落（带 text/note 类型，兼容旧的纯字符串数组） */
  paragraphs: Paragraph[] | string[]
  /** 从第几段开始播放（旧接口，优先级低于 startSentenceIndex） */
  startParagraphIndex?: number
  /** 从第几个句子（segment）开始播放 */
  startSentenceIndex?: number
  /** 正文音色 key */
  voiceKey?: string
  /** 注释音色 key（不传则与正文相同） */
  noteVoiceKey?: string
  /** 播放倍速 */
  rate?: number
  /** 当前段落变化回调 */
  onParagraph?: (index: number) => void
  /** 当前句子（segment）变化回调 */
  onSentence?: (segIndex: number) => void
  /** 状态变化回调 */
  onStatus?: (status: TtsStatus, message?: string) => void
  /** 合成进度回调 */
  onSynthProgress?: (p: TtsProgress) => void
  /**
   * 合成结束 + 尝试写入文件（外部 .mp3 + IDB）之后异步触发。
   * fileOk === false 表示"钱扣了但音频没保存到磁盘"，UI 需要提示用户；
   * fileOk === true 表示保存成功（或纯 Web 环境不需要存）。
   */
  onFileSaved?: (r: { fileOk: boolean; idbOk: boolean; error?: string }) => void
  /** 每日花费预算上限（元），0 或不传表示不限制 */
  budgetYuan?: number
}

export interface SynthChapterOpts {
  bookId: string
  bookTitle: string
  chapterId: string
  chapterTitle: string
  /** 章节段落（带 text/note 类型，兼容纯字符串数组） */
  paragraphs: Paragraph[] | string[]
  /** 从第几个句子开始合成（默认章首；顺序为起点向后到末尾，再回头到起点） */
  startSentenceIndex?: number
  voiceKey?: string
  noteVoiceKey?: string
  budgetYuan?: number
  onSynthProgress?: (p: TtsProgress) => void
  onStatus?: (status: TtsStatus, message?: string) => void
  onFileSaved?: (r: { fileOk: boolean; idbOk: boolean; error?: string }) => void
}

export interface TtsController {
  playChapter: (opts: PlayChapterOpts) => Promise<void>
  /** 只合成不播放：提前生成整章音频（stop() 可中断，已完成部分照常存缓存） */
  synthChapter: (opts: SynthChapterOpts) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  getStatus: () => TtsStatus
  listVoices: () => Promise<TtsVoiceRef[]>
}

export { VOICE_CATALOG, voicesForLang, DEFAULT_VOICE_ZH, DEFAULT_VOICE_EN, DEFAULT_VOICE_NOTE }

class SpeakAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'SpeakAborted'
  }
}

class BudgetExceeded extends Error {
  todayYuan: number
  budgetYuan: number
  constructor(todayYuan: number, budgetYuan: number) {
    super(`今日花费 ¥${todayYuan.toFixed(2)} 已超过预算上限 ¥${budgetYuan.toFixed(2)}`)
    this.name = 'BudgetExceeded'
    this.todayYuan = todayYuan
    this.budgetYuan = budgetYuan
  }
}

export { BudgetExceeded }

/**
 * Blob → base64 data URI（分块编码，避免一次性展开超长参数栈溢出）。
 * Android WebView 的 <audio> 无法加载 blob: URL（报 "The element has no
 * supported sources."），原生端统一改用 data URI 播放。
 */
async function blobToDataUri(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x2000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK)
    bin += String.fromCharCode(...(sub as unknown as number[]))
  }
  return `data:${blob.type || 'audio/mpeg'};base64,${btoa(bin)}`
}

/** 把原始 TTS 错误分类为用户可读的「标题 + 建议」。 */
export function classifyTtsError(rawErr: unknown): { title: string; advice: string; retryable: boolean } {
  const msg = rawErr instanceof Error ? rawErr.message : String(rawErr ?? '')
  const lower = msg.toLowerCase()

  // 1. 网络层（浏览器/原生通用）
  if (lower.includes('failed to fetch') || lower.includes('network error') || lower.includes('net::') || lower.includes('timeout') || lower.includes('连接超时') || lower.includes('请求超时')) {
    return {
      title: '网络请求失败',
      advice: '请检查网络连接（Wi-Fi/流量），确认能正常上网后重试。',
      retryable: true,
    }
  }

  // 2. MiniMax HTTP 限流/配额
  if (/429|rate.?limit|quota|频率|限流|额度|余额不足/.test(lower)) {
    return {
      title: '语音平台限流或额度不足',
      advice: '每分钟有调用上限，请等待 1~2 分钟再试；如长期出现请检查 MiniMax 账户余额或 API Key 权限。',
      retryable: true,
    }
  }

  // 3. 认证
  if (/401|403|unauthorized|forbidden|鉴权|授权|invalid key|bearer/.test(lower)) {
    return {
      title: 'API Key 无效或未授权',
      advice: '请到「设置 → 解锁密钥」重新输入 MiniMax API Key；如已设置，请确认 Key 的字符与官网完全一致。',
      retryable: false,
    }
  }

  // 4. 参数错误
  if (/400|invalid param|bad request|参数/.test(lower)) {
    return {
      title: '合成参数非法',
      advice: '文本中可能包含不支持的特殊字符，可跳过该句或改选其他音色再试。',
      retryable: true,
    }
  }

  // 5. 服务端 5xx
  if (/^HTTP\s*5\d{2}|500|502|503|504|server error|服务端|服务器/.test(lower)) {
    return {
      title: '语音平台服务异常',
      advice: 'MiniMax 平台暂时不可用，请 5~10 分钟后重试；若持续较长时间可考虑切换音色或稍后再读。',
      retryable: true,
    }
  }

  // 6. 解码失败
  if (/解码失败|decode|base64|hex|audio data/.test(lower)) {
    return {
      title: '音频解码失败',
      advice: '网络传输可能损坏了音频数据，重试一次即可；如果持续失败请关闭 VPN 或代理软件。',
      retryable: true,
    }
  }

  // 7. 媒体元素加载/播放失败（Android WebView 的 blob: URL 兼容问题等）
  if (lower.includes('no supported sources') || lower.includes('not suitable') || msg.includes('音频播放失败')) {
    return {
      title: '音频播放失败',
      advice: '音频已合成成功但播放器加载失败，请重试朗读；若持续出现请重启 App 后再试。',
      retryable: true,
    }
  }

  // 8. 其他已知但不严重
  if (msg === 'aborted' || rawErr instanceof SpeakAborted) {
    return {
      title: '已停止',
      advice: '',
      retryable: false,
    }
  }

  // 兜底
  return {
    title: '朗读失败',
    advice: '未知错误，请稍后重试。如持续失败可开启调试面板查看详细日志，或反馈给开发者。',
    retryable: true,
  }
}

function toRef(v: VoiceDef, index: number): TtsVoiceRef {
  return {
    index,
    lang: v.lang === 'both' ? 'zh/en' : v.lang === 'zh' ? 'zh-CN' : 'en',
    name: v.name,
    key: v.key,
    gender: v.gender,
  }
}

interface CharRange {
  start: number
  end: number
}

/**
 * 一个播放段 = 一个句子，对应一次语音合成 API 调用。
 * - voiceKey：该段使用的音色
 * - firstPara/lastPara：在 paragraphs 中的索引（闭区间）
 * - charStart/charEnd：该段在全局拼接文本中的字符区间
 * - blob：合成好的音频（缓存里就有，否则在合成阶段赋值）
 */
interface PlaySegment {
  voiceKey: string
  voiceId: string
  /** t2a_v2 language_boost：普通话 'Chinese' / 英文 'English'（禁用 'auto'，会被误判成粤语） */
  languageBoost: string
  firstPara: number
  lastPara: number
  charStart: number
  charEnd: number
  blob?: Blob
  /** 消费者等待此 promise（生产者合成完该段后 resolve） */
  blobReady?: Promise<void>
  _resolveReady?: () => void
  _rejectReady?: (e: Error) => void
}

/** 把段落拼成全文字符串（段间 \n），并记录每段全局字符区间 */
function buildTextAndRanges(paras: Paragraph[]): { fullText: string; paraRanges: CharRange[] } {
  let fullText = ''
  const paraRanges: CharRange[] = []
  for (const p of paras) {
    const start = fullText.length
    fullText += p.text
    paraRanges.push({ start, end: fullText.length })
    fullText += '\n'
  }
  return { fullText, paraRanges }
}

/**
 * 按句子切分，生成 PlaySegment 列表：每个句子 = 一个 segment = 一次 API 调用。
 *   - 句子结束标点：。！？；…\n . ! ? ;
 *   - 每个句子用所属段落的音色（正文/注释）
 *   - 段尾没有结束标点的剩余部分也作为一个 segment
 */
function planSegments(
  paras: Paragraph[],
  paraRanges: CharRange[],
  textVoice: VoiceDef,
  noteVoice: VoiceDef,
): PlaySegment[] {
  const pickVoice = (k: ParagraphKind) => (k === 'note' ? noteVoice : textVoice)
  const boostOf = (v: VoiceDef) => (v.lang === 'en' ? 'English' : 'Chinese')
  const out: PlaySegment[] = []

  for (let pi = 0; pi < paras.length; pi++) {
    const para = paras[pi]
    const voice = pickVoice(para.kind)
    const range = paraRanges[pi]
    const text = para.text
    if (!text) continue

    let sentStart = 0 // 当前句子在段落内的起始偏移
    for (let ci = 0; ci < text.length; ci++) {
      if (isSentenceEnd(text[ci])) {
        const absStart = range.start + sentStart
        const absEnd = range.start + ci + 1 // 包含标点本身
        if (absEnd > absStart) {
          out.push({
            voiceKey: voice.key,
            voiceId: voice.voiceId,
            languageBoost: boostOf(voice),
            firstPara: pi,
            lastPara: pi,
            charStart: absStart,
            charEnd: absEnd,
          })
        }
        sentStart = ci + 1
      }
    }
    // 段尾没有结束标点的剩余部分
    if (sentStart < text.length) {
      out.push({
        voiceKey: voice.key,
        voiceId: voice.voiceId,
        languageBoost: boostOf(voice),
        firstPara: pi,
        lastPara: pi,
        charStart: range.start + sentStart,
        charEnd: range.end,
      })
    }
  }

  return out
}

const clampRate = (r: number) => Math.min(2, Math.max(0.5, r))

/** 合成节流：每合成完一段后等待的间隔（ms），控制 API 请求频率避免触发平台限流 */
const SYNTH_GAP_MS = 1000

/**
 * 章节音频缓存键（唯一出处，合成/播放/下划线标记共用）。
 * __v2：合成参数版本——修复 language_boost:'auto' 被误判成粤语的问题，
 * 旧缓存音频语种错误，整键作废强制重合成。
 */
export function chapterCacheKey(bookId: string, chapterId: string, voiceKey: string, noteVoiceKey: string): string {
  return `${bookId}__${chapterId}__${voiceKey}__${noteVoiceKey}__v2`
}

/** 章节预处理结果（playChapter / synthChapter 共用） */
interface PreparedChapter {
  fullText: string
  paraRanges: CharRange[]
  textHash: string
  cacheKey: string
  segments: PlaySegment[]
  startSegIdx: number
}

/**
 * 段落规范化 → 构建全文与区间 → 缓存还原 blob → 计算起始段。
 * 无可读内容时返回 null。
 */
async function prepareChapter(
  opts: {
    bookId: string
    chapterId: string
    paragraphs: Paragraph[] | string[]
    startSentenceIndex?: number
    startParagraphIndex?: number
  },
  textVoice: VoiceDef,
  noteVoice: VoiceDef,
): Promise<PreparedChapter | null> {
  const rawParas = opts.paragraphs
  if (rawParas.length === 0) return null
  // 兼容调用方传纯文本字符串数组（旧签名 paragraphs: string[]）
  const paras: Paragraph[] = rawParas.map((p) =>
    typeof p === 'string' ? { text: p.trim(), kind: 'text' as ParagraphKind } : p,
  ).filter((p) => p.text)

  const { fullText, paraRanges } = buildTextAndRanges(paras)
  const textHash = hashText(fullText)
  const cacheKey = chapterCacheKey(opts.bookId, opts.chapterId, textVoice.key, noteVoice.key)

  let clip: ChapterAudio | null = null
  try {
    clip = await getClip(cacheKey)
  } catch {
    clip = null
  }

  const segments = planSegments(paras, paraRanges, textVoice, noteVoice)

  // 尝试用缓存还原 segments.blob（支持部分命中，不 break）
  if (clip && clip.textHash === textHash && clip.chunks?.length) {
    for (const seg of segments) {
      const idx = clip.chunks.findIndex(
        (c) => c.charStart === seg.charStart && c.charEnd === seg.charEnd && c.blob.size > 0,
      )
      if (idx >= 0) seg.blob = clip.chunks[idx].blob
    }
  }

  // 计算起始 segment（生产者和消费者共用）
  let startSegIdx: number
  if (opts.startSentenceIndex != null) {
    startSegIdx = Math.max(0, Math.min(opts.startSentenceIndex, segments.length - 1))
  } else {
    const startIndex = Math.min(opts.startParagraphIndex ?? 0, paraRanges.length - 1)
    const startChar = paraRanges[startIndex].start
    startSegIdx = segments.findIndex((s) => startChar >= s.charStart && startChar < s.charEnd)
    if (startSegIdx < 0) startSegIdx = 0
  }

  return { fullText, paraRanges, textHash, cacheKey, segments, startSegIdx }
}

/** 保存已有 blob 的段：IDB 缓存 + 物理文件（fire-and-forget，结果回调 onFileSaved） */
function persistSegments(
  segments: PlaySegment[],
  prep: Pick<PreparedChapter, 'textHash' | 'cacheKey'>,
  textVoice: VoiceDef,
  noteVoice: VoiceDef,
  meta: { bookId: string; bookTitle: string; chapterId: string; chapterTitle: string },
  onFileSaved?: (r: { fileOk: boolean; idbOk: boolean; error?: string }) => void,
): void {
  const completedSegs = segments.filter((s) => s.blob)
  if (completedSegs.length === 0) return
  const chunks: AudioChunk[] = completedSegs.map((s) => ({
    charStart: s.charStart,
    charEnd: s.charEnd,
    blob: s.blob!,
  }))
  const newClip: ChapterAudio = {
    chunks,
    textHash: prep.textHash,
    voiceKey: `${textVoice.key}|${noteVoice.key}`,
    createdAt: Date.now(),
  }
  const voiceLabel = textVoice.name + (noteVoice.key !== textVoice.key ? ` · ${noteVoice.name}注释` : '')
  const fileMeta: ChapterFileMeta = {
    bookId: meta.bookId,
    bookTitle: meta.bookTitle,
    chapterId: meta.chapterId,
    chapterTitle: meta.chapterTitle,
    voiceKey: textVoice.key,
    noteVoiceKey: noteVoice.key,
    voiceLabel,
  }
  void putClip(prep.cacheKey, newClip, fileMeta)
    .then((res) => {
      onFileSaved?.({ fileOk: res.fileOk, idbOk: res.idbOk, error: res.fileError })
    })
    .catch((e) => {
      onFileSaved?.({
        fileOk: false,
        idbOk: false,
        error: e instanceof Error ? e.message : String(e),
      })
    })
}

export function createTtsController(): TtsController {
  let status: TtsStatus = 'idle'
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null
  let playWait: { resolve: () => void; reject: (e: Error) => void } | null = null
  let speakEpoch = 0
  let currentSegments: PlaySegment[] | null = null
  let synthAbortFn: (() => void) | null = null
  let currentPlayPromise: Promise<void> | null = null
  /** 当前 waitForMetadata 的结算函数（stop 时立即释放，防止旧 Promise 永不 resolve 卡死下一次播放） */
  let metaWaiter: (() => void) | null = null

  const assertAlive = (epoch: number) => {
    if (epoch !== speakEpoch) throw new SpeakAborted()
  }

  /** 可中断的等待：每 100ms 检查一次 epoch，用户停止时立即返回（由调用方 assertAlive 抛出中止） */
  const sleepInterruptible = (ms: number, epoch: number) =>
    new Promise<void>((resolve) => {
      const startedAt = Date.now()
      const tick = window.setInterval(() => {
        if (epoch !== speakEpoch || Date.now() - startedAt >= ms) {
          window.clearInterval(tick)
          resolve()
        }
      }, 100)
    })

  const cleanupAudio = () => {
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.src = ''
      audio = null
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  const finishPlayWait = (err?: Error) => {
    const w = playWait
    playWait = null
    if (!w) return
    if (err) w.reject(err)
    else w.resolve()
  }

  /**
   * 生产者：按序合成 segments，每段就绪后 resolve blobReady 通知消费者。
   * 合成顺序从 startSegIdx 开始（确保首句最快就绪），再到 wrap-around 段（缓存完整性）。
   */
  const synthesizeSegments = async (
    fullText: string,
    segments: PlaySegment[],
    onSynthProgress: ((p: TtsProgress) => void) | undefined,
    epoch: number,
    bookTitle: string,
    startSegIdx: number,
    budgetYuan?: number,
  ): Promise<void> => {
    // 合成顺序：从播放起点开始，确保首句最快就绪
    const order: number[] = []
    for (let i = startSegIdx; i < segments.length; i++) order.push(i)
    for (let i = 0; i < startSegIdx; i++) order.push(i)

    const needCount = segments.filter((s) => !s.blob).length
    let done = 0

    try {
      for (const idx of order) {
        assertAlive(epoch)
        const seg = segments[idx]
        if (seg.blob) continue
        const text = fullText.slice(seg.charStart, seg.charEnd)
        const voiceLabel = seg.voiceKey
        onSynthProgress?.({
          stage: 'synth',
          progress: done / Math.max(1, needCount),
          message: `合成${voiceLabel.startsWith('note:') ? '注释' : '正文'}段 ${done + 1}/${needCount}（${text.length} 字）`,
        })
        agentLog('tts.ts:synth', 'segment start', { seg: idx + 1, total: segments.length, chars: text.length, voice: voiceLabel }, 'C')
        // 预算检查：超出上限则停止后续合成
        const budgetCheck = await checkBudget(budgetYuan)
        if (budgetCheck?.exceeded) {
          const err = new BudgetExceeded(budgetCheck.todayYuan, budgetCheck.budgetYuan)
          // 拒绝所有未完成的段
          for (const seg of segments) {
            if (!seg.blob) seg._rejectReady?.(err)
          }
          throw err
        }
        const blob = await synthesizeChunk(
          text,
          seg.voiceId,
          (p: SynthProgress) => {
            const overall = (done + p.progress) / Math.max(1, needCount)
            onSynthProgress?.({
              stage: p.stage,
              progress: Math.min(0.99, overall),
              message: p.message,
            })
          },
          () => assertAlive(epoch),
          (abortFn) => { synthAbortFn = abortFn },
          seg.languageBoost,
        )
        synthAbortFn = null
        seg.blob = blob
        await addSynthChars(text.length, bookTitle)
        seg._resolveReady?.()
        done++
        // 节流：合成完一段等 1 秒再发下一个请求，控制请求频率，
        // 避免生产者冲刺备货时每分钟上百次请求触发平台 Rate Limit（429）。
        // 全部就绪则不等；等待可被 stop 中断
        if (segments.some((s) => !s.blob)) {
          await sleepInterruptible(SYNTH_GAP_MS, epoch)
          assertAlive(epoch)
        }
      }
    } catch (e) {
      // 合成失败/中止：拒绝所有未完成的 deferred，防止消费者死等
      for (const seg of segments) {
        if (!seg.blob) seg._rejectReady?.(e instanceof Error ? e : new Error(String(e)))
      }
      throw e
    }
  }

  const waitForMetadata = (el: HTMLAudioElement) =>
    new Promise<void>((resolve) => {
      if (isFinite(el.duration) && el.duration > 0) return resolve()
      const settle = () => {
        if (metaWaiter !== settle) return
        metaWaiter = null
        el.removeEventListener('loadedmetadata', onMeta)
        el.removeEventListener('error', onErr)
        resolve()
      }
      const onMeta = () => settle()
      const onErr = () => settle()
      metaWaiter = settle
      el.addEventListener('loadedmetadata', onMeta)
      el.addEventListener('error', onErr)
      // 兜底超时：无条件结算（epoch 校验交给调用方的 assertAlive），
      // 避免 stop 后事件不触发导致 Promise 永不 resolve
      window.setTimeout(settle, 5000)
    })

  const playChunkToEnd = (el: HTMLAudioElement, epoch: number) =>
    new Promise<void>((resolve, reject) => {
      playWait = { resolve, reject }
      const onEnded = () => {
        cleanupAudio()
        finishPlayWait()
      }
      const onErr = () => {
        cleanupAudio()
        finishPlayWait(new Error(`音频播放失败: ${el.error?.message ?? '未知错误'}`))
      }
      el.addEventListener('ended', onEnded, { once: true })
      el.addEventListener('error', onErr, { once: true })
      void el.play().then(
        () => {
          agentLog('tts.ts:playChunk', 'play() resolved', { epoch, rate: el.playbackRate }, 'D')
        },
        (e) => {
          el.removeEventListener('ended', onEnded)
          el.removeEventListener('error', onErr)
          cleanupAudio()
          finishPlayWait(e instanceof Error ? e : new Error(String(e)))
        },
      )
    })

  /** 消费者：顺序播放 segments，blob 未就绪时等待生产者合成完成 */
  const playSegments = async (
    segments: PlaySegment[],
    paraRanges: CharRange[],
    opts: PlayChapterOpts,
    epoch: number,
    startSegIdx: number,
  ) => {
    const startIndex = segments[startSegIdx]?.firstPara ?? 0

    for (let si = startSegIdx; si < segments.length; si++) {
      assertAlive(epoch)
      const seg = segments[si]
      // 生产者-消费者协同：blob 未就绪时等待合成完成
      if (!seg.blob) {
        if (seg.blobReady) {
          await seg.blobReady
          assertAlive(epoch)
        }
        if (!seg.blob) throw new Error('播放段缺少音频 blob（合成未完成或缓存损坏）')
      }
      // 释放上一段的 objectUrl（每段都独立 create 一个，连续播放时避免累积）
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
      }
      let src: string
      if (Capacitor.isNativePlatform()) {
        // Android WebView 的媒体管线无法加载 blob: URL（报 "The element has no
        // supported sources."），原生端改用 base64 data URI；Web 端保留 blob URL
        src = await blobToDataUri(seg.blob)
        assertAlive(epoch)
      } else {
        objectUrl = URL.createObjectURL(seg.blob)
        src = objectUrl
      }
      const el = new Audio(src)
      audio = el
      el.playbackRate = clampRate(opts.rate ?? 1)
      el.volume = 1

      await waitForMetadata(el)
      assertAlive(epoch)

      let lastReported = -1
      const reportAt = (force?: number) => {
        const dur = el.duration
        let charOff = seg.charStart
        if (isFinite(dur) && dur > 0) {
          charOff = seg.charStart + (el.currentTime / dur) * (seg.charEnd - seg.charStart)
          if (charOff >= seg.charEnd) charOff = seg.charEnd - 1
        }
        let p = seg.firstPara
        for (let k = seg.firstPara; k <= seg.lastPara; k++) {
          if (paraRanges[k].start <= charOff) p = k
          else break
        }
        if (force !== undefined) p = force
        if (p !== lastReported) {
          lastReported = p
          opts.onParagraph?.(p)
        }
      }
      const onTime = () => {
        if (epoch !== speakEpoch) return
        reportAt()
      }
      el.addEventListener('timeupdate', onTime)

      if (si === startSegIdx) {
        const ps = paraRanges[startIndex].start
        if (ps > seg.charStart && isFinite(el.duration) && el.duration > 0) {
          const ratio = (ps - seg.charStart) / (seg.charEnd - seg.charStart)
          try {
            el.currentTime = Math.max(0, ratio * el.duration)
          } catch {
            /* ignore */
          }
        }
        reportAt(startIndex)
      }

      status = 'speaking'
      opts.onSentence?.(si)
      opts.onStatus?.('speaking')
      agentLog(
        'tts.ts:playSegments',
        'seg play start',
        {
          seg: si + 1,
          total: segments.length,
          bytes: seg.blob.size,
          voice: seg.voiceKey,
          paras: `${seg.firstPara}-${seg.lastPara}`,
        },
        'A',
      )

      try {
        await playChunkToEnd(el, epoch)
      } finally {
        el.removeEventListener('timeupdate', onTime)
      }
      assertAlive(epoch)
    }

    status = 'idle'
    opts.onStatus?.('idle')
  }

  const stopInternal = () => {
    speakEpoch += 1
    status = 'idle'
    // 1. 中断正在进行的 HTTP 合成请求（如果有）
    if (synthAbortFn) {
      try { synthAbortFn() } catch { /* ignore */ }
      synthAbortFn = null
    }
    // 2. 立即 reject 所有未完成的 blobReady，让消费者从 await blobReady 中解除
    if (currentSegments) {
      const aborted = new SpeakAborted()
      for (const seg of currentSegments) {
        if (!seg.blob) seg._rejectReady?.(aborted)
      }
      currentSegments = null
    }
    // 3. 中断消费者的 playWait（如果正在播放或等待 ended）
    cleanupAudio()
    finishPlayWait(new SpeakAborted())
    // 4. 释放卡在 waitForMetadata 的消费者。
    // 注意：不能先置空再调用——settle 内部有 metaWaiter !== settle 守卫，
    // 先置空会导致守卫命中、永不 resolve，playChapter 永久挂起（P0）
    if (metaWaiter) {
      metaWaiter()
    }
  }

  return {
    listVoices: async () => VOICE_CATALOG.map(toRef),

    async playChapter(opts) {
      // 串行化：先中断旧播放，再等待旧 Promise 完成，避免并发
      if (currentPlayPromise) {
        stopInternal()
        try { await currentPlayPromise } catch { /* 旧播放已中止 */ }
      }

      const promise = (async () => {
        const epoch = ++speakEpoch
        cleanupAudio()
      status = 'loading'
      opts.onStatus?.('loading', '正在准备语音…')

      const textVoice = getVoice(opts.voiceKey) || VOICE_CATALOG[0]
      const noteVoice = opts.noteVoiceKey
        ? getVoice(opts.noteVoiceKey) || textVoice
        : textVoice

      const prep = await prepareChapter(opts, textVoice, noteVoice)
      if (!prep) {
        status = 'idle'
        opts.onStatus?.('idle', '本章无可朗读内容')
        return
      }
      const { segments, paraRanges, fullText, cacheKey, startSegIdx } = prep
      currentSegments = segments

      const needSynth = segments.some((s) => !s.blob)
      let producerPromise: Promise<void> | null = null

      if (needSynth) {
        // 为未缓存的段创建 deferred（消费者 await blobReady，生产者 resolve）
        for (const seg of segments) {
          if (!seg.blob) {
            let resolveFn!: () => void
            let rejectFn!: (e: Error) => void
            seg.blobReady = new Promise<void>((res, rej) => { resolveFn = res; rejectFn = rej })
            seg._resolveReady = resolveFn
            seg._rejectReady = rejectFn
            seg.blobReady.catch(() => {}) // 防止 unhandled rejection
          }
        }

        status = 'loading'
        opts.onStatus?.('loading', '正在在线合成语音…')
        agentLog(
          'tts.ts:playChapter',
          'synth start (streaming)',
          {
            cacheKey,
            textVoice: textVoice.key,
            noteVoice: noteVoice.key,
            chars: fullText.length,
            segments: segments.length,
            cachedBlobs: segments.filter((s) => s.blob).length,
          },
          'A',
        )

        // 启动生产者（不 await，后台合成，首句就绪后消费者即可播放）
        producerPromise = synthesizeSegments(
          fullText, segments, opts.onSynthProgress, epoch, opts.bookTitle || '未知', startSegIdx, opts.budgetYuan,
        )
      } else {
        agentLog('tts.ts:playChapter', 'cache hit', { cacheKey, segments: segments.length }, 'A')
        opts.onStatus?.('loading', '已缓存，直接播放…')
      }

      assertAlive(epoch)
      try {
        await playSegments(segments, paraRanges, opts, epoch, startSegIdx)
      } catch (err) {
        if (err instanceof SpeakAborted || (err instanceof Error && (err.name === 'SpeakAborted' || err.message === 'aborted'))) {
          return
        }
        // 播放失败（非中止）：立即停止后台合成，避免用户已听不了却还在持续计费
        if (producerPromise) stopInternal()
        throw err
      } finally {
        // 生产者 + 缓存保存改为后台执行，不阻塞 playChapter resolve
        // （避免 HTTP 请求挂起时用户无法 stop 或再次播放）
        if (producerPromise) {
          void producerPromise
            .catch(() => { /* abort 或合成错误 */ })
            .then(() => {
              // 生产者跑完（或已被 abort）后，保存已完成的段
              persistSegments(segments, prep, textVoice, noteVoice, opts, opts.onFileSaved)
            })
        }
        // 清 segments 引用（避免 stop 再操作旧 segments）
        if (currentSegments === segments) currentSegments = null
        // 立即设置 status idle（不需要等生产者）
        if (epoch === speakEpoch && (status as TtsStatus) !== 'paused') status = 'idle'
      }
      })() // async IIFE end

      currentPlayPromise = promise
      try {
        await promise
      } finally {
        if (currentPlayPromise === promise) currentPlayPromise = null
      }
    },

    async synthChapter(opts) {
      // 串行化：先中断旧的播放/合成任务
      if (currentPlayPromise) {
        stopInternal()
        try { await currentPlayPromise } catch { /* 旧任务已中止 */ }
      }

      const promise = (async () => {
        const epoch = ++speakEpoch
        cleanupAudio()
        status = 'loading'
        opts.onStatus?.('loading', '正在准备合成…')

        const textVoice = getVoice(opts.voiceKey) || VOICE_CATALOG[0]
        const noteVoice = opts.noteVoiceKey
          ? getVoice(opts.noteVoiceKey) || textVoice
          : textVoice

        const prep = await prepareChapter(opts, textVoice, noteVoice)
        if (!prep) {
          status = 'idle'
          opts.onStatus?.('idle', '本章无可合成内容')
          return
        }
        currentSegments = prep.segments

        const needCount = prep.segments.filter((s) => !s.blob).length
        if (needCount === 0) {
          agentLog('tts.ts:synthChapter', 'all cached', { cacheKey: prep.cacheKey, segments: prep.segments.length }, 'A')
          status = 'idle'
          opts.onStatus?.('idle', '本章已全部合成过')
          return
        }

        agentLog(
          'tts.ts:synthChapter',
          'start',
          { cacheKey: prep.cacheKey, segments: prep.segments.length, need: needCount, chars: prep.fullText.length },
          'A',
        )
        opts.onStatus?.('loading', `开始合成 ${needCount} 段…`)

        try {
          // 纯合成模式无播放消费者，不需要创建 blobReady deferred；
          // stop() 通过 epoch + synthAbortFn 中断，抛出 SpeakAborted 由调用方处理
          await synthesizeSegments(
            prep.fullText, prep.segments, opts.onSynthProgress, epoch, opts.bookTitle || '未知', prep.startSegIdx, opts.budgetYuan,
          )
          opts.onStatus?.('idle', '合成完成')
        } finally {
          // 无论正常完成还是被中断，已完成的段都保存（钱已花，不保存就白扣了）
          persistSegments(prep.segments, prep, textVoice, noteVoice, opts, opts.onFileSaved)
          if (currentSegments === prep.segments) currentSegments = null
          if (epoch === speakEpoch && (status as TtsStatus) !== 'paused') status = 'idle'
        }
      })()

      currentPlayPromise = promise
      try {
        await promise
      } finally {
        if (currentPlayPromise === promise) currentPlayPromise = null
      }
    },

    pause() {
      if (status !== 'speaking' || !audio) return
      audio.pause()
      status = 'paused'
    },
    resume() {
      if (status !== 'paused' || !audio) return
      status = 'speaking'
      void audio.play().catch(() => {})
    },
    stop() {
      stopInternal()
    },
    getStatus: () => status,
  }
}
