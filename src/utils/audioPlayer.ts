/**
 * 音频包播放器：按 manifest 的句级偏移驱动单章 mp3。
 *
 * 核心：把章节 mp3 拆成「段」序列驱动播放。
 *   - 正文句按 index 顺序连续（[startMs, endMs) 首尾相接）；
 *   - 某句含 noteRef 时，播完该句 → 跳到对应注释 [startMs, endMs) → 回到下一句继续。
 * 通过 currentTime 轮询 + 段边界 seek 实现，无爆音、句级高亮、注释跳播。
 *
 * 「句首重复」修复要点（Android WebView 上必现）：
 *   1. 轮询有滞后（setInterval 100ms + 媒体时钟刷新），触发切段时真实播放位置
 *      已经跑到段起点之后 100~300ms。若此时无条件 seek 回段首，就会把刚念过的
 *      那一小段再播一遍 —— 听感即「每句开头重复一下」。
 *   → advance 前先比较：播放位置已在目标段内就不回退，直接接上继续播。
 *   2. 必须回退时（章首 / 跳句 / 跳注释）：先 pause 再 seek，并等 `seeked` 事件
 *      完成后才 play()，否则 seek 生效前会吐出旧位置（上一句尾巴）的残留音频。
 */
import type { AudioChapter, AudioNote } from '../types'

export type PlayerStatus = 'idle' | 'playing' | 'paused' | 'ended'

export interface PlayerCallbacks {
  /** 当前正文句 index 变化（开始播某句时触发） */
  onSentence?: (index: number) => void
  /** 开始播某条注释（跳播时触发） */
  onNote?: (noteId: string) => void
  /** 开始播本章标题（章首朗读「这是哪一章」时触发一次，index 恒为 -1） */
  onTitle?: (index: number) => void
  onStatus?: (status: PlayerStatus, msg?: string) => void
  /** 本章播完（正文+注释都结束） */
  onChapterEnd?: () => void
}

type Segment =
  | { kind: 'body'; start: number; end: number; sentenceIndex: number }
  | { kind: 'note'; start: number; end: number; noteId: string }
  /** 章标题：位于整章开头，播完自动落到正文第 0 句 */
  | { kind: 'title'; start: number; end: number; index: number }

export interface PlayChapterOptions {
  url: string
  chapter: AudioChapter
  rate?: number
  /** 从第几句正文开始（默认 0） */
  startSentenceIndex?: number
  callbacks: PlayerCallbacks
}

/** 把一章摊平成播放段序列（标题 → 正文句 / 注释交替）。导出供测试断言段顺序。 */
export function buildSegments(chapter: AudioChapter, withTitle: boolean): Segment[] {
  const noteById = new Map<string, AudioNote>(chapter.notes.map((n) => [n.id, n]))
  const segs: Segment[] = []
  const ts = chapter.titleStartMs ?? 0
  const te = chapter.titleEndMs ?? ts
  if (withTitle && ts >= 0 && te > ts) {
    segs.push({ kind: 'title', start: ts, end: te, index: -1 })
  }
  for (const s of chapter.sentences) {
    segs.push({ kind: 'body', start: s.startMs, end: s.endMs, sentenceIndex: s.index })
    for (const ref of s.noteRef ?? []) {
      const n = noteById.get(ref)
      if (n) segs.push({ kind: 'note', start: n.startMs, end: n.endMs, noteId: n.id })
    }
  }
  return segs
}

export interface AudioPlayerController {
  playChapter: (opts: PlayChapterOptions) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  seekToSentence: (index: number) => void
  /** 跳回章首标题段（本章无标题朗读段时无效） */
  seekToTitle: () => void
  seekToNote: (noteId: string) => void
  isStopped: () => boolean
}

export function createAudioPlayer(): AudioPlayerController {
  let audio: HTMLAudioElement | null = null
  let segments: Segment[] = []
  let segIndex = -1
  let cb: PlayerCallbacks = {}
  let stopped = true
  let timer: number | null = null

  const ensureAudio = (): HTMLAudioElement => {
    if (!audio) {
      audio = new Audio()
      audio.preload = 'auto'
    }
    return audio
  }

  const clearTimer = () => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  const emit = (seg: Segment | undefined) => {
    if (!seg) return
    if (seg.kind === 'body') cb.onSentence?.(seg.sentenceIndex)
    else if (seg.kind === 'title') cb.onTitle?.(seg.index)
    else cb.onNote?.(seg.noteId)
  }

  /** seek 到指定毫秒，等 seeked 完成才 resolve（seek 未完成时 play 会吐出旧位置残留） */
  const seekTo = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const a = ensureAudio()
      let done = false
      const finish = () => {
        if (done) return
        done = true
        a.removeEventListener('seeked', onSeeked)
        window.clearTimeout(timer)
        resolve()
      }
      const onSeeked = () => finish()
      const timer = window.setTimeout(finish, 800)
      a.addEventListener('seeked', onSeeked)
      a.currentTime = ms / 1000
    })

  /** 回退到段首并把该段播起来（章首 / 跳句 / 跳注释等必须回退的场景） */
  const seekIntoSegment = async (seg: Segment) => {
    const a = ensureAudio()
    // 已经在段首附近（含章首 0 位置）就不必 seek，省一次 seeked 等待
    if (Math.abs((a.currentTime || 0) * 1000 - seg.start) < 20) {
      void a.play().catch(() => {})
      return
    }
    a.pause()
    await seekTo(seg.start)
    void a.play().catch(() => {})
  }

  const advance = () => {
    segIndex++
    if (segIndex >= segments.length) {
      stop()
      cb.onChapterEnd?.()
      return
    }
    const seg = segments[segIndex]
    const a = ensureAudio()
    emit(seg)
    // 播放位置已落到本段内（轮询滞后的常态）→ 不回退 seek，直接接上，
    // 否则会把本段开头刚播过的那 100~300ms 重播一遍。
    if ((a.currentTime || 0) * 1000 >= seg.start - 20) {
      void a.play().catch(() => {})
      return
    }
    void seekIntoSegment(seg)
  }

  const tick = () => {
    if (stopped || !audio || segIndex < 0 || segIndex >= segments.length) return
    const seg = segments[segIndex]
    // 提前 30ms 触发，抵消轮询滞后，尽量让位置停在段首附近
    if (audio.currentTime * 1000 >= seg.end - 30) advance()
  }

  const startTimer = () => {
    clearTimer()
    timer = window.setInterval(tick, 100)
  }

  async function playChapter(opts: PlayChapterOptions): Promise<void> {
    cb = opts.callbacks
    const a = ensureAudio()
    // 停止上一个任务
    clearTimer()
    a.pause()
    a.src = ''
    stopped = true
    segIndex = -1

    // 从章首播放时（startSentenceIndex=0）先念章标题，再进正文；
    // 从中间某句起播则跳过标题，避免已经读过还再念一遍。
    segments = buildSegments(opts.chapter, (opts.startSentenceIndex ?? 0) <= 0)
    let start = 0
    const startIdx = opts.startSentenceIndex ?? 0
    if (startIdx > 0) {
      const i = segments.findIndex(
        (seg) => seg.kind === 'body' && seg.sentenceIndex >= startIdx,
      )
      if (i >= 0) start = i
    }
    segIndex = start

    a.src = opts.url
    a.playbackRate = opts.rate && opts.rate > 0 ? opts.rate : 1

    // 等待元数据就绪后才能 seek
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      a.addEventListener('loadedmetadata', done, { once: true })
      window.setTimeout(done, 2000)
    })

    const seg = segments[segIndex]
    stopped = false
    cb.onStatus?.('playing')
    if (seg) {
      await seekIntoSegment(seg)
      emit(seg)
    }
    startTimer()
  }

  function pause() {
    if (stopped) return
    audio?.pause()
    cb.onStatus?.('paused')
  }

  function resume() {
    if (stopped || !audio) return
    void audio.play().catch(() => {})
    cb.onStatus?.('playing')
  }

  function stop() {
    stopped = true
    segIndex = -1
    clearTimer()
    if (audio) {
      audio.pause()
      audio.src = ''
    }
    cb.onStatus?.('idle')
  }

  function seekToSegment(seg: Segment | undefined) {
    if (!seg) return
    emit(seg)
    if (audio && audio.src) void seekIntoSegment(seg)
  }

  function seekToSentence(index: number) {
    const i = segments.findIndex((seg) => seg.kind === 'body' && seg.sentenceIndex === index)
    if (i < 0) return
    segIndex = i
    seekToSegment(segments[i])
  }

  /** 回到章首重念标题（仅当本章带标题朗读段时有效） */
  function seekToTitle() {
    const i = segments.findIndex((seg) => seg.kind === 'title')
    if (i < 0) return
    segIndex = i
    seekToSegment(segments[i])
  }

  function seekToNote(noteId: string) {
    const i = segments.findIndex((seg) => seg.kind === 'note' && seg.noteId === noteId)
    if (i < 0) return
    segIndex = i
    seekToSegment(segments[i])
  }

  return {
    playChapter,
    pause,
    resume,
    stop,
    seekToSentence,
    seekToTitle,
    seekToNote,
    isStopped: () => stopped,
  }
}
