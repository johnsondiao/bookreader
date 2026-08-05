/**
 * TTS 总调度器 —— MiniMax 在线整章合成 + 本地缓存播放。
 *
 * 工作模式（替代旧的本地 piper/sherpa 逐句合成）：
 *   - 打开一章时，把整章正文按段落边界切成 ≤ 4.8 万字的块，
 *     每块调用 MiniMax 异步 T2A（speech-2.8-turbo）合成一次 mp3。
 *   - 合成结果（分块 Blob）存入 IndexedDB，键为 bookId:chapterId:voiceKey，
 *     并用 textHash 校验；已缓存的章节直接播放，绝不重复花钱合成。
 *   - 播放时按「字符比例」把当前播放位置映射到段落，回调高亮当前段。
 *
 * 同步粒度为段落级（与旧实现一致）：整章音频按段落字符占比估算当前位置，
 * 对中文朗读足够准确；不依赖 MiniMax 字幕（v2 接口未稳定返回字幕）。
 */
import { agentLog } from './agentLog'
import { synthesizeChunk, type SynthProgress } from './minimaxTts'
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
  /** 章节正文按段切好的数组（已 trim、过滤空段） */
  paragraphs: string[]
  /** 从第几段开始播放（点击段落定位 / 上段下段时使用） */
  startParagraphIndex?: number
  /** 音色 key（应用内稳定 key，对应 VoiceDef.key） */
  voiceKey?: string
  /** 播放倍速 */
  rate?: number
  /** 当前段落变化时回调（用于高亮 + 滚动 + 记进度） */
  onParagraph?: (index: number) => void
  /** 状态变化回调 */
  onStatus?: (status: TtsStatus, message?: string) => void
  /** 合成阶段进度回调 */
  onSynthProgress?: (p: TtsProgress) => void
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

/** 把段落拼接成全文（段间用 \n），并记录每段在全文中的字符区间 */
function buildTextAndRanges(paras: string[]): { fullText: string; paraRanges: CharRange[] } {
  let fullText = ''
  const paraRanges: CharRange[] = []
  for (const p of paras) {
    const start = fullText.length
    fullText += p
    paraRanges.push({ start, end: fullText.length })
    fullText += '\n'
  }
  return { fullText, paraRanges }
}

/** 按段落边界规划分块，每块 ≤ MAX_CHUNK_CHARS 字 */
function planChunks(paras: string[], paraRanges: CharRange[]): { firstPara: number; lastPara: number; charStart: number; charEnd: number }[] {
  const out: { firstPara: number; lastPara: number; charStart: number; charEnd: number }[] = []
  let i = 0
  while (i < paras.length) {
    let j = i
    let acc = 0
    while (j < paras.length && acc + paras[j].length + 1 <= MAX_CHUNK_CHARS) {
      acc += paras[j].length + 1
      j++
    }
    if (j === i) j = i + 1 // 单段超长时强制至少一段
    out.push({ firstPara: i, lastPara: j - 1, charStart: paraRanges[i].start, charEnd: paraRanges[j - 1].end })
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
  /** stop() / 新 playChapter() 递增；异步流程中校验以中止旧会话 */
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

  /** 合成整章：按块逐个调用 MiniMax，返回分块音频 */
  const synthesizeChapter = async (
    fullText: string,
    paras: string[],
    paraRanges: CharRange[],
    voiceId: string,
    onSynthProgress: ((p: TtsProgress) => void) | undefined,
    epoch: number,
  ): Promise<AudioChunk[]> => {
    const plans = planChunks(paras, paraRanges)
    const chunks: AudioChunk[] = []
    for (let i = 0; i < plans.length; i++) {
      assertAlive(epoch)
      const plan = plans[i]
      const text = fullText.slice(plan.charStart, plan.charEnd)
      onSynthProgress?.({
        stage: 'synth',
        progress: i / plans.length,
        message: `在线合成中…（第 ${i + 1}/${plans.length} 段，${text.length} 字）`,
      })
      // #region agent log
      agentLog('tts.ts:synthesizeChapter', 'chunk start', { chunk: i + 1, total: plans.length, chars: text.length }, 'C')
      // #endregion
      const blob = await synthesizeChunk(
        text,
        voiceId,
        (p: SynthProgress) => {
          const overall = (i + p.progress) / plans.length
          onSynthProgress?.({
            stage: p.stage,
            progress: Math.min(0.99, overall),
            message: p.message,
          })
        },
        () => assertAlive(epoch),
      )
      chunks.push({ charStart: plan.charStart, charEnd: plan.charEnd, blob })
    }
    return chunks
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
      // 兜底：blob 元数据偶尔不触发，5s 后强制继续
      window.setTimeout(() => {
        if (epoch === speakEpoch) resolve()
      }, 5000)
    })

  /** 播放单个块直至 ended；stop/换块时通过 finishPlayWait 结束 */
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
          // #region agent log
          agentLog('tts.ts:playChunk', 'play() resolved', { epoch, rate: el.playbackRate }, 'D')
          // #endregion
        },
        (e) => {
          el.removeEventListener('ended', onEnded)
          el.removeEventListener('error', onErr)
          cleanupAudio()
          finishPlayWait(e instanceof Error ? e : new Error(String(e)))
        },
      )
    })

  /** 顺序播放所有分块，按字符比例回调当前段落 */
  const playChunks = async (
    clip: ChapterAudio,
    paraRanges: CharRange[],
    opts: PlayChapterOpts,
    epoch: number,
  ) => {
    const startIndex = Math.min(opts.startParagraphIndex ?? 0, paraRanges.length - 1)
    const startChar = paraRanges[startIndex].start
    let startChunkIdx = clip.chunks.findIndex((c) => startChar >= c.charStart && startChar < c.charEnd)
    if (startChunkIdx < 0) startChunkIdx = 0

    for (let ci = startChunkIdx; ci < clip.chunks.length; ci++) {
      assertAlive(epoch)
      const chunk = clip.chunks[ci]
      objectUrl = URL.createObjectURL(chunk.blob)
      const el = new Audio(objectUrl)
      audio = el
      el.playbackRate = clampRate(opts.rate ?? 1)
      el.volume = 1

      await waitForMetadata(el, epoch)
      assertAlive(epoch)

      let lastReported = -1
      const reportAt = (force?: number) => {
        const dur = el.duration
        let charOff = chunk.charStart
        if (isFinite(dur) && dur > 0) {
          charOff = chunk.charStart + (el.currentTime / dur) * (chunk.charEnd - chunk.charStart)
          if (charOff >= chunk.charEnd) charOff = chunk.charEnd - 1
        }
        let p = 0
        for (let k = 0; k < paraRanges.length; k++) {
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

      // 首块定位到起始段落
      if (ci === startChunkIdx) {
        const ps = paraRanges[startIndex].start
        if (ps > chunk.charStart && isFinite(el.duration) && el.duration > 0) {
          const ratio = (ps - chunk.charStart) / (chunk.charEnd - chunk.charStart)
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
      // #region agent log
      agentLog(
        'tts.ts:playChunks',
        'chunk play start',
        { chunk: ci + 1, total: clip.chunks.length, bytes: chunk.blob.size, duration: el.duration },
        'A',
      )
      // #endregion

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

      const voice = getVoice(opts.voiceKey) || VOICE_CATALOG[0]
      const paras = opts.paragraphs.map((p) => p.trim()).filter(Boolean)
      if (paras.length === 0) {
        status = 'idle'
        opts.onStatus?.('idle', '本章无可朗读内容')
        return
      }

      const { fullText, paraRanges } = buildTextAndRanges(paras)
      const textHash = hashText(fullText)
      const cacheKey = `${opts.bookId}__${opts.chapterId}__${voice.key}`

      let clip = await getClip(cacheKey)
      if (!clip || clip.textHash !== textHash || !clip.chunks?.length) {
        status = 'loading'
        opts.onStatus?.('loading', '正在在线合成整章语音（首次需联网，之后缓存）…')
        // #region agent log
        agentLog(
          'tts.ts:playChapter',
          'synth start',
          { cacheKey, voice: voice.key, chars: fullText.length, hit: false },
          'A',
        )
        // #endregion
        const chunks = await synthesizeChapter(fullText, paras, paraRanges, voice.voiceId, opts.onSynthProgress, epoch)
        assertAlive(epoch)
        clip = { chunks, textHash, voiceKey: voice.key, createdAt: Date.now() }
        await putClip(cacheKey, clip)
        opts.onStatus?.('loading', '合成完成，准备播放…')
      } else {
        // #region agent log
        agentLog('tts.ts:playChapter', 'cache hit', { cacheKey, voice: voice.key, chunks: clip.chunks.length }, 'A')
        // #endregion
        opts.onStatus?.('loading', '已缓存，直接播放…')
      }

      assertAlive(epoch)
      try {
        await playChunks(clip, paraRanges, opts, epoch)
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
