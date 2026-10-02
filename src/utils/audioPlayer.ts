/**
 * 音频包播放器：按 manifest 的句级偏移驱动单章 mp3。
 *
 * ## 核心设计：整章顺序播放 + 位置推导高亮（进度途中零 seek）
 *
 * 一章 mp3 的物理内容就是「章标题 → 正文（逐句连读）→ 注释」一整条，
 * 所以正确做法是把整章当成一个连续音轨从头播到尾，**只在用户主动点击时
 * 才 seek**。朗读位置的高亮、注释高亮，全部由 `currentTime` 反查时间轴得出。
 *
 * 为什么不能「每句 seek 一次」：Android WebView 上报的 `currentTime` 是媒体
 * 时钟的阶梯值（约 250ms 刷新一次），并且**滞后于真正在喇叭里响的位置**
 * 一个输出缓冲（实测 200~300ms，正好是一个汉字）。任何一次「seek 回段首」，
 * 都会把该段开头已经念过的那 200~300ms 再念一遍 —— 听感就是
 * 「每句开头重复一个字 / 三个字」。
 *
 * 历史版本踩过的坑：
 *   ① 无条件 `currentTime = seg.start`（每句重复 3 个字）
 *   ② 改成「位置已在段内就不回退」（每句仍重复 1 个字，因为 fallback 分支
 *      还是 seek 了，而触发时上报位置恰好落在段起点之前）
 * 最终方案：进度路径上根本不产生 seek，重复从原理上不可能发生。
 *
 * 副作用（已与 manifest 布局一致，不算损失）：注释按**物理顺序**在正文念完后
 * 连读（mp3 本来就是这么排的）；「某句引用注释 → 播完这句插读注释」需要
 * seek（播完这句后要跳回正文），因此不再自动插播，改为点注释角标手动跳播。
 */
import type { AudioChapter } from '../types'

export type PlayerStatus = 'idle' | 'playing' | 'paused' | 'ended'

export interface PlayerCallbacks {
  /** 当前正文句 index 变化（开始播某句时触发） */
  onSentence?: (index: number) => void
  /** 开始播某条注释（跳播 / 播到注释区时触发） */
  onNote?: (noteId: string) => void
  /** 开始播本章标题（章首朗读「这是哪一章」时触发一次，index 恒为 -1） */
  onTitle?: (index: number) => void
  onStatus?: (status: PlayerStatus, msg?: string) => void
  /** 本章播完（正文+注释都结束） */
  onChapterEnd?: () => void
}

/** 时间轴上的一个槽位：与 mp3 的物理时间顺序严格一致（按 start 升序） */
export type Segment =
  | { kind: 'body'; start: number; end: number; sentenceIndex: number }
  | { kind: 'note'; start: number; end: number; noteId: string }
  /** 章标题：位于整章开头 */
  | { kind: 'title'; start: number; end: number; index: number; sentenceIndex: number }

export interface PlayChapterOptions {
  url: string
  chapter: AudioChapter
  rate?: number
  /** 从第几句正文开始（默认 0，即从章首开始连播） */
  startSentenceIndex?: number
  callbacks: PlayerCallbacks
}

/**
 * 把一章摊平成**时间升序**的槽位序列：标题 → 正文句 → 注释。
 * 导出供测试断言顺序；排序后直接当时间轴用，播放器不需要任何跳转。
 */
export function buildSegments(chapter: AudioChapter, withTitle: boolean): Segment[] {
  const segs: Segment[] = []
  const ts = chapter.titleStartMs ?? 0
  const te = chapter.titleEndMs ?? ts
  if (withTitle && ts >= 0 && te > ts) {
    segs.push({ kind: 'title', start: ts, end: te, index: -1, sentenceIndex: -1 })
  }
  for (const s of chapter.sentences) {
    segs.push({ kind: 'body', start: s.startMs, end: s.endMs, sentenceIndex: s.index })
  }
  // 注释按 manifest 顺序排在正文之后（与 mp3 物理内容一致）
  for (const n of chapter.notes) {
    if (n.startMs != null && n.endMs != null) {
      segs.push({ kind: 'note', start: n.startMs, end: n.endMs, noteId: n.id })
    }
  }
  segs.sort((a, b) => a.start - b.start)
  return segs
}

/**
 * 二分：返回播放位置 t 对应的槽位下标 = 最后一个 start <= t 的槽位。
 * 落在句间空档（TTS 的静音间隙）时沿用前一个槽位，高亮不闪断；
 * 仅当 t 早于整个时间轴起点时才返回 -1。导出供测试断言推导正确性。
 */
export function activeSlotIndex(segments: Segment[], t: number): number {
  let lo = 0
  let hi = segments.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].start <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
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
  /** 当前高亮对应的槽位下标（仅用于「变了才回调」，不参与播放控制） */
  let cursor = -1
  let cb: PlayerCallbacks = {}
  let stopped = true
  let timer: number | null = null
  /** 本章的 ended 监听（换章/停止时要摘掉，避免上一章的收尾回调打到新章） */
  let endHandler: (() => void) | null = null

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

  /**
   * 用户主动跳转才走这里：先 pause，等 seeked 完成再 play，
   * 避免 seek 生效前把旧位置（上一段尾巴）的残留音频吐出来。
   * 跳转到未来（续读某句）和回退（点注释角标）都用它，均属用户意图，重复可容忍。
   */
  const seekInto = async (seg: Segment) => {
    const a = ensureAudio()
    cursor = segments.indexOf(seg)
    if (!a.src || a.readyState === 0) {
      emit(seg)
      return
    }
    a.pause()
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        a.removeEventListener('seeked', onSeeked)
        window.clearTimeout(t)
        resolve()
      }
      const onSeeked = () => finish()
      const t = window.setTimeout(finish, 800)
      a.addEventListener('seeked', onSeeked)
      a.currentTime = seg.start / 1000
    })
    emit(seg)
    if (stopped) return
    void a.play().catch(() => {})
  }

  /** 每 100ms 只看一眼播放位置，反查该高亮哪一句 —— 全程不写 currentTime */
  const tick = () => {
    if (stopped || !audio || segments.length === 0) return
    const t = (audio.currentTime || 0) * 1000
    const last = segments[segments.length - 1]
    // 兜底：mp3 比 manifest 长约百来毫秒（LAME 帧对齐），正常收尾走 ended 事件，
    // 这里只防音频缓冲卡死不会真的播完。
    if (t >= last.end + 2000) {
      finish()
      return
    }
    const i = activeSlotIndex(segments, t)
    if (i !== cursor && i >= 0) {
      cursor = i
      emit(segments[i])
    }
  }

  const finish = () => {
    if (stopped) return
    stop()
    cb.onChapterEnd?.()
  }

  const startTimer = () => {
    clearTimer()
    timer = window.setInterval(tick, 100)
  }

  async function playChapter(opts: PlayChapterOptions): Promise<void> {
    cb = opts.callbacks
    const a = ensureAudio()
    clearTimer()
    if (endHandler) {
      a.removeEventListener('ended', endHandler)
      endHandler = null
    }
    a.pause()
    a.src = ''
    stopped = true

    segments = buildSegments(opts.chapter, (opts.startSentenceIndex ?? 0) <= 0)
    // 续读中间某句：一次性前跳到该句（forward seek，用户意图，无重复风险）
    const startIdx = opts.startSentenceIndex ?? 0
    let target = 0
    if (startIdx > 0) {
      const i = segments.findIndex((s) => s.kind === 'body' && s.sentenceIndex >= startIdx)
      if (i >= 0) target = i
    }

    a.src = opts.url
    a.playbackRate = opts.rate && opts.rate > 0 ? opts.rate : 1

    // 等待元数据就绪后才能 seek / 读 currentTime
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      a.addEventListener('loadedmetadata', done, { once: true })
      window.setTimeout(done, 2000)
    })

    const onEnded = () => finish()
    endHandler = onEnded
    a.addEventListener('ended', onEnded)

    stopped = false
    cursor = target
    cb.onStatus?.('playing')
    if (target > 0) {
      await seekInto(segments[target])
    } else {
      emit(segments[target])
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
    cursor = -1
    clearTimer()
    if (audio) {
      if (endHandler) {
        audio.removeEventListener('ended', endHandler)
        endHandler = null
      }
      audio.pause()
      audio.src = ''
    }
    cb.onStatus?.('idle')
  }

  function seekToSegment(seg: Segment | undefined) {
    if (!seg) return
    if (audio && audio.src) void seekInto(seg)
    else emit(seg)
  }

  function seekToSentence(index: number) {
    const i = segments.findIndex((s) => s.kind === 'body' && s.sentenceIndex === index)
    if (i < 0) return
    cursor = i
    seekToSegment(segments[i])
  }

  /** 回到章首重念标题（仅当本章带标题朗读段时有效） */
  function seekToTitle() {
    const i = segments.findIndex((s) => s.kind === 'title')
    if (i < 0) return
    cursor = i
    seekToSegment(segments[i])
  }

  function seekToNote(noteId: string) {
    const i = segments.findIndex((s) => s.kind === 'note' && s.noteId === noteId)
    if (i < 0) return
    cursor = i
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
