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
import { agentLog } from './agentLog'
import { estimateTtsCost, synthesizeChunk, type SynthProgress } from './minimaxTts'
import { getClip, hashText, putClip, type AudioChunk, type ChapterAudio } from './audioCache'
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
  chapterId: string
  /** 章节段落（带 text/note 类型，兼容旧的纯字符串数组） */
  paragraphs: Paragraph[] | string[]
  /** 从第几段开始播放 */
  startParagraphIndex?: number
  /** 正文音色 key */
  voiceKey?: string
  /** 注释音色 key（不传则与正文相同） */
  noteVoiceKey?: string
  /** 播放倍速 */
  rate?: number
  /** 当前段落变化回调 */
  onParagraph?: (index: number) => void
  /** 状态变化回调 */
  onStatus?: (status: TtsStatus, message?: string) => void
  /** 合成进度回调 */
  onSynthProgress?: (p: TtsProgress) => void
  /** 合成前的费用预估回调（仅当需要在线合成时触发，返回 true 才继续） */
  onCostEstimate?: (chars: number, costYuan: number) => boolean | Promise<boolean>
}

export interface TtsController {
  playChapter: (opts: PlayChapterOpts) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  getStatus: () => TtsStatus
  listVoices: () => Promise<TtsVoiceRef[]>
}

export { VOICE_CATALOG, voicesForLang, DEFAULT_VOICE_ZH, DEFAULT_VOICE_EN, DEFAULT_VOICE_NOTE }

/** MiniMax 单次 t2a_async_v2 的 text 字段上限 5 万字，留余量按 4.8 万切块 */
const MAX_CHUNK_CHARS = 48000

class SpeakAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'SpeakAborted'
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
 * 一个播放段：相同音色的连续段落合并成一段音频。
 * - voiceKey：该段使用的音色
 * - firstPara/lastPara：在 paragraphs 中的索引（闭区间）
 * - charStart/charEnd：该段在全局拼接文本中的字符区间
 * - blob：合成好的音频（缓存里就有，否则在合成阶段赋值）
 * - groupKey：合成块的分组 key（供整章跨合成次数复用）
 */
interface PlaySegment {
  voiceKey: string
  voiceId: string
  firstPara: number
  lastPara: number
  charStart: number
  charEnd: number
  blob?: Blob
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
 * 按音色分组（正文 / 注释）生成 PlaySegment 列表：
 *   - 相同音色的连续段落合并成一段
 *   - 同音色连续超过 MAX_CHUNK_CHARS 时，按段落边界切多段
 */
function planSegments(
  paras: Paragraph[],
  paraRanges: CharRange[],
  textVoice: VoiceDef,
  noteVoice: VoiceDef,
): PlaySegment[] {
  const pickVoice = (k: ParagraphKind) => (k === 'note' ? noteVoice : textVoice)
  const out: PlaySegment[] = []
  let i = 0
  while (i < paras.length) {
    const voice = pickVoice(paras[i].kind)
    let j = i
    let acc = 0
    while (j < paras.length) {
      const p = paras[j]
      if (pickVoice(p.kind).key !== voice.key) break
      const nextLen = acc + p.text.length + 1
      if (nextLen > MAX_CHUNK_CHARS && j > i) break
      acc = nextLen
      j++
    }
    if (j === i) j = i + 1
    out.push({
      voiceKey: voice.key,
      voiceId: voice.voiceId,
      firstPara: i,
      lastPara: j - 1,
      charStart: paraRanges[i].start,
      charEnd: paraRanges[j - 1].end,
    })
    i = j
  }
  return out
}

const clampRate = (r: number) => Math.min(2, Math.max(0.5, r))

export function createTtsController(): TtsController {
  let status: TtsStatus = 'idle'
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null
  let playWait: { resolve: () => void; reject: (e: Error) => void } | null = null
  let speakEpoch = 0

  const assertAlive = (epoch: number) => {
    if (epoch !== speakEpoch) throw new SpeakAborted()
  }

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
   * 按组合成：segments 是按音色合并的播放段列表。
   * 把同 voiceKey 的 segments 按顺序合成（避免重复任务），把 blob 填回 segment.blob。
   */
  const synthesizeSegments = async (
    fullText: string,
    segments: PlaySegment[],
    onSynthProgress: ((p: TtsProgress) => void) | undefined,
    epoch: number,
  ): Promise<void> => {
    const total = segments.length
    for (let i = 0; i < total; i++) {
      assertAlive(epoch)
      const seg = segments[i]
      if (seg.blob) continue
      const text = fullText.slice(seg.charStart, seg.charEnd)
      const voiceLabel = seg.voiceKey
      onSynthProgress?.({
        stage: 'synth',
        progress: i / Math.max(1, total),
        message: `合成${voiceLabel.startsWith('note:') ? '注释' : '正文'}段 ${i + 1}/${total}（${text.length} 字）`,
      })
      agentLog('tts.ts:synth', 'segment start', { seg: i + 1, total, chars: text.length, voice: voiceLabel }, 'C')
      const blob = await synthesizeChunk(
        text,
        seg.voiceId,
        (p: SynthProgress) => {
          const overall = (i + p.progress) / Math.max(1, total)
          onSynthProgress?.({
            stage: p.stage,
            progress: Math.min(0.99, overall),
            message: p.message,
          })
        },
        () => assertAlive(epoch),
      )
      seg.blob = blob
    }
  }

  const waitForMetadata = (el: HTMLAudioElement, epoch: number) =>
    new Promise<void>((resolve) => {
      if (isFinite(el.duration) && el.duration > 0) return resolve()
      const onMeta = () => {
        el.removeEventListener('loadedmetadata', onMeta)
        resolve()
      }
      const onErr = () => {
        el.removeEventListener('error', onErr)
        resolve()
      }
      el.addEventListener('loadedmetadata', onMeta)
      el.addEventListener('error', onErr)
      window.setTimeout(() => {
        if (epoch === speakEpoch) resolve()
      }, 5000)
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

  /** 顺序播放 segments，按字符比例回调当前段落 */
  const playSegments = async (
    segments: PlaySegment[],
    paraRanges: CharRange[],
    opts: PlayChapterOpts,
    epoch: number,
  ) => {
    const startIndex = Math.min(opts.startParagraphIndex ?? 0, paraRanges.length - 1)
    const startChar = paraRanges[startIndex].start
    let startSegIdx = segments.findIndex((s) => startChar >= s.charStart && startChar < s.charEnd)
    if (startSegIdx < 0) startSegIdx = 0

    for (let si = startSegIdx; si < segments.length; si++) {
      assertAlive(epoch)
      const seg = segments[si]
      if (!seg.blob) throw new Error('播放段缺少音频 blob（合成未完成或缓存损坏）')
      objectUrl = URL.createObjectURL(seg.blob)
      const el = new Audio(objectUrl)
      audio = el
      el.playbackRate = clampRate(opts.rate ?? 1)
      el.volume = 1

      await waitForMetadata(el, epoch)
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

  return {
    listVoices: async () => VOICE_CATALOG.map(toRef),

    async playChapter(opts) {
      const epoch = ++speakEpoch
      cleanupAudio()
      status = 'loading'
      opts.onStatus?.('loading', '正在准备语音…')

      const textVoice = getVoice(opts.voiceKey) || VOICE_CATALOG[0]
      const noteVoice = opts.noteVoiceKey
        ? getVoice(opts.noteVoiceKey) || textVoice
        : textVoice

      const rawParas = opts.paragraphs
      if (rawParas.length === 0) {
        status = 'idle'
        opts.onStatus?.('idle', '本章无可朗读内容')
        return
      }
      // 兼容调用方传纯文本字符串数组（旧签名 paragraphs: string[]）
      const paras: Paragraph[] = rawParas.map((p) =>
        typeof p === 'string' ? { text: p.trim(), kind: 'text' as ParagraphKind } : p,
      ).filter((p) => p.text)

      const { fullText, paraRanges } = buildTextAndRanges(paras)
      const textHash = hashText(fullText)
      // 缓存维度：正文音色 + 注释音色
      const cacheKey = `${opts.bookId}__${opts.chapterId}__${textVoice.key}__${noteVoice.key}`

      let clip: ChapterAudio | null = null
      try {
        clip = await getClip(cacheKey)
      } catch {
        clip = null
      }

      let segments: PlaySegment[] = planSegments(paras, paraRanges, textVoice, noteVoice)

      // 尝试用缓存还原 segments.blob
      const cached: PlaySegment[] = []
      if (clip && clip.textHash === textHash && clip.chunks?.length) {
        // 按 charStart/charEnd 精确匹配：同一本书同一个音色组合下，
        // planSegments 相同输入输出相同，charStart/charEnd 完全一致即可复用
        const remaining = [...clip.chunks]
        let ok = true
        for (const seg of segments) {
          const idx = remaining.findIndex(
            (c) => c.charStart === seg.charStart && c.charEnd === seg.charEnd && c.blob.size > 0,
          )
          if (idx < 0) {
            ok = false
            break
          }
          seg.blob = remaining[idx].blob
          remaining.splice(idx, 1)
        }
        if (ok) cached.push(...segments)
      }

      const needSynth = cached.length !== segments.length || segments.some((s) => !s.blob)

      if (needSynth) {
        // 费用预估：统计需要新合成的字符数（缓存命中的段不计费）
        const newSynthChars = segments
          .filter((s) => !s.blob)
          .reduce((sum, s) => sum + (s.charEnd - s.charStart), 0)
        const estCost = estimateTtsCost(newSynthChars)

        // 回调上层：显示确认弹窗；返回 false 则取消
        if (opts.onCostEstimate) {
          const confirmed = await opts.onCostEstimate(newSynthChars, estCost)
          if (!confirmed) {
            status = 'idle'
            opts.onStatus?.('idle', '已取消合成')
            return
          }
        }

        status = 'loading'
        opts.onStatus?.('loading', '正在在线合成整章语音（首次需联网，之后缓存）…')
        agentLog(
          'tts.ts:playChapter',
          'synth start',
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
        await synthesizeSegments(fullText, segments, opts.onSynthProgress, epoch)
        assertAlive(epoch)
        // 写回缓存
        const chunks: AudioChunk[] = segments.map((s) => ({
          charStart: s.charStart,
          charEnd: s.charEnd,
          blob: s.blob!,
        }))
        clip = { chunks, textHash, voiceKey: `${textVoice.key}|${noteVoice.key}`, createdAt: Date.now() }
        void putClip(cacheKey, clip)
        opts.onStatus?.('loading', '合成完成，准备播放…')
      } else {
        agentLog('tts.ts:playChapter', 'cache hit', { cacheKey, segments: segments.length }, 'A')
        opts.onStatus?.('loading', '已缓存，直接播放…')
      }

      assertAlive(epoch)
      try {
        await playSegments(segments, paraRanges, opts, epoch)
      } catch (err) {
        if (err instanceof SpeakAborted || (err instanceof Error && (err.name === 'SpeakAborted' || err.message === 'aborted'))) {
          return
        }
        throw err
      } finally {
        if (epoch === speakEpoch && (status as TtsStatus) !== 'paused') status = 'idle'
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
      speakEpoch += 1
      status = 'idle'
      cleanupAudio()
      finishPlayWait(new SpeakAborted())
    },
    getStatus: () => status,
  }
}
