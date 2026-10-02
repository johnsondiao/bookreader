/**
 * 音频包播放器：按 manifest 的句级偏移驱动单章 mp3。
 *
 * 核心：把章节 mp3 拆成「段」序列驱动播放。
 *   - 正文句按 index 顺序连续（[startMs, endMs) 首尾相接）；
 *   - 某句含 noteRef 时，播完该句 → 跳到对应注释 [startMs, endMs) → 回到下一句继续。
 * 通过 currentTime 轮询 + 段边界 seek 实现，无爆音、句级高亮、注释跳播。
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

  const advance = () => {
    segIndex++
    if (segIndex >= segments.length) {
      stop()
      cb.onChapterEnd?.()
      return
    }
    const seg = segments[segIndex]
    const a = ensureAudio()
    a.currentTime = seg.start / 1000
    emit(seg)
    void a.play().catch(() => {})
  }

  const tick = () => {
    if (stopped || !audio || segIndex < 0 || segIndex >= segments.length) return
    const seg = segments[segIndex]
    if (audio.currentTime * 1000 >= seg.end) advance()
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
    if (seg) a.currentTime = seg.start / 1000
    stopped = false
    emit(seg)
    cb.onStatus?.('playing')
    await a.play()
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

  function seekToSentence(index: number) {
    const i = segments.findIndex((seg) => seg.kind === 'body' && seg.sentenceIndex === index)
    if (i < 0) return
    segIndex = i
    if (audio && audio.src) {
      audio.currentTime = segments[i].start / 1000
      emit(segments[i])
    }
  }

  /** 回到章首重念标题（仅当本章带标题朗读段时有效） */
  function seekToTitle() {
    const i = segments.findIndex((seg) => seg.kind === 'title')
    if (i < 0) return
    segIndex = i
    if (audio && audio.src) {
      audio.currentTime = segments[i].start / 1000
      emit(segments[i])
    }
  }

  function seekToNote(noteId: string) {
    const i = segments.findIndex((seg) => seg.kind === 'note' && seg.noteId === noteId)
    if (i < 0) return
    segIndex = i
    if (audio && audio.src) {
      audio.currentTime = segments[i].start / 1000
      emit(segments[i])
    }
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
