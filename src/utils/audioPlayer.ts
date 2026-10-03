/**
 * 音频包播放器。
 *
 * ## 主模式：按句切字节，一次只播「这一句那一块」(chunk)
 *
 * 一章 mp3 是 CBR 流，所以「第 i 句」在文件里就是一段确定的字节：
 * **[第 i 句开头, 第 i+1 句开头)**。播放时把这段字节 `Blob.slice()` 出来
 * 单独喂给 `<audio>`，播完再换下一段。
 *
 * 这样「每句开头重复一个字」从原理上被消灭了：
 *   - 播的是**精确的一段字节**，起点就是这句的第一帧，不存在「把上一句尾巴
 *     和下一句开头一起读进来」的可能；
 *   - 跳句 / 跳注释不再是 seek（seek 会连带重放缓冲区里已念过的那 200~300ms），
 *     而是直接换 src，没有重播窗口；
 *   - 高亮由「当前在播第几段」直接决定，不靠 currentTime 反推。
 *
 * 帧边界对齐（chapterChunks 负责）：切片必须从完整帧开头切，否则解码器丢帧；
 * 段尾最多多带一帧（32kbps/16k 时 = 36ms，是句尾静音，听不出来）。
 *
 * ## 回退模式：整章顺序播放（旧实现，保留）
 *
 * 极少数环境里 `<audio src="blob:...">` 解不了（部分 WebView 内核），
 * 或者 mp3 帧头解不出来 / VBR。这时自动回退：整章一条流连播，
 * 高亮仍由 `currentTime` 反查（沿用注释里的 seek 铁律：进度路径不写 currentTime）。
 * 回退意味着可能回到「每句开头重复」的老表现，但至少能听。
 */
import type { AudioChapter } from '../types'
import { buildChunkSlots, buildChapterGeometry, byteRange, type ChunkSlot, type ChapterGeometry } from './chapterChunks'

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

/** 把一章摊平成**时间升序**的槽位序列（标题 → 正文句 → 注释），回退模式用 */
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
 * 仅回退模式用；切句模式下高亮由段序号直接给出。
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

/** 整章字节缓存（切句模式要用它反复 Blob.slice，避免每次重新下载） */
const byteCache = new Map<string, ArrayBuffer>()
const BYTE_CACHE_MAX = 2

async function loadChapterBytes(url: string): Promise<ArrayBuffer | null> {
  if (!url) return null
  const hit = byteCache.get(url)
  if (hit) return hit
  try {
    const ctrl = new AbortController()
    const id = window.setTimeout(() => ctrl.abort(), 30000)
    const res = await fetch(url, { signal: ctrl.signal })
    window.clearTimeout(id)
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 4096) return null
    byteCache.set(url, buf)
    while (byteCache.size > BYTE_CACHE_MAX) {
      const oldest = byteCache.keys().next().value
      if (oldest === undefined) break
      byteCache.delete(oldest)
    }
    return buf
  } catch {
    return null
  }
}

export function createAudioPlayer(): AudioPlayerController {
  let audio: HTMLAudioElement | null = null
  let cb: PlayerCallbacks = {}
  let stopped = true
  /** chunk = 按句切字节（主）；continuous = 整章连播（回退） */
  let mode: 'chunk' | 'continuous' = 'continuous'
  let timer: number | null = null
  let rate = 1

  // —— 回退模式状态 ——
  let segments: Segment[] = []
  let cursor = -1

  // —— 切句模式状态 ——
  let slots: ChunkSlot[] = []
  let bytes: ArrayBuffer | null = null
  let geo: ChapterGeometry | null = null
  let slotIdx = -1
  const chunkUrls = new Map<number, string>()
  let watchdog: number | null = null
  let userPaused = false
  /** 上一次看门狗观测到的播放位置，用于判断「卡住不动」 */
  let lastTime = -1

  const ensureAudio = (): HTMLAudioElement => {
    if (!audio) {
      audio = new Audio()
      audio.preload = 'auto'
      audio.addEventListener('ended', () => {
        if (stopped) return
        if (mode === 'chunk' && slotIdx >= 0) void playSlot(slotIdx + 1)
      })
      audio.addEventListener('error', () => {
        if (stopped) return
        if (mode === 'chunk') fallbackContinuous()
      })
    }
    return audio
  }

  const clearTimer = () => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  const clearWatchdog = () => {
    if (watchdog !== null) {
      window.clearTimeout(watchdog)
      watchdog = null
    }
  }

  /** chunk 模式：为第 i 段现切一段字节并生成 objectURL（惰性，用完自动回收） */
  const makeChunkUrl = (i: number): string | null => {
    if (!bytes || !geo) return null
    const cached = chunkUrls.get(i)
    if (cached) return cached
    const slot = slots[i]
    if (!slot) return null
    // 用**物理区间**切：段首往回借到「上一句说完」，那截真静音正好给解码器补
    // 比特蓄水池的借位数据，否则段首 1~2 帧解不出来（听感是每句开头一声「呲」）。
    // 高亮/排序仍用逻辑区间（slot.startMs），两者分开。
    const r = byteRange(geo, slot.cutStartMs, slot.cutEndMs)
    if (r.end <= r.start || r.start >= bytes.byteLength) return null
    const part = bytes.slice(r.start, r.end)
    const url = URL.createObjectURL(new Blob([part], { type: 'audio/mpeg' }))
    chunkUrls.set(i, url)
    // 只留最近 6 段的 URL，更早的及时 revoke（Blob 底层数据仍在，切回来时重新 slice）
    if (chunkUrls.size > 6) {
      const oldest = chunkUrls.keys().next().value
      if (oldest !== undefined && oldest !== i) {
        const u = chunkUrls.get(oldest)
        if (u) URL.revokeObjectURL(u)
        chunkUrls.delete(oldest)
      }
    }
    return url
  }

  const emitChunk = (slot: ChunkSlot) => {
    if (slot.kind === 'body') cb.onSentence?.(slot.sentenceIndex)
    else if (slot.kind === 'title') cb.onTitle?.(slot.index)
    else cb.onNote?.(slot.noteId)
  }

  const startWatchdog = () => {
    clearWatchdog()
    // 新的一段塞进播放器却一直没出声 / 卡住不动 → 这个环境解不了 blob 切片，回退整章
    watchdog = window.setTimeout(() => {
      if (stopped || mode !== 'chunk') return
      const a = ensureAudio()
      // 用户自己按的暂停不算「播不出来」
      if (userPaused) return
      if (a.paused || a.error || Math.abs(a.currentTime - lastTime) < 0.01) {
        fallbackContinuous()
        return
      }
      lastTime = a.currentTime
    }, 1200)
  }

  /** chunk 模式播放第 i 段（播完自动进下一段，由 audio 的 ended 驱动） */
  /** 播放令牌：快速连点跳句时，旧的 playSlot 回来后发现自己过期就直接放弃 */
  let playToken = 0

  async function playSlot(i: number) {
    if (stopped || mode !== 'chunk') return
    const token = ++playToken
    const slot = slots[i]
    if (!slot) {
      finish()
      return
    }
    const a = ensureAudio()
    const url = makeChunkUrl(i)
    if (!url) {
      fallbackContinuous()
      return
    }
    slotIdx = i
    if (a.src !== url) a.src = url
    // 倍速必须在换src **之后** 设：改 src 会触发媒体加载流程，实测会把 playbackRate
    // 复位到 defaultPlaybackRate（默认 1.0）。切句模式每句换一个 blob URL，
    // 顺序反了的话每句都会被冲成 1.0x，设置面板的倍速完全不起作用。
    a.playbackRate = rate
    a.defaultPlaybackRate = rate
    emitChunk(slot)
    if (stopped) return
    startWatchdog()
    try {
      await a.play()
      lastTime = a.currentTime
    } catch {
      /* play() 被拒/失败：ended 或 watchdog 会兜底 */
    }
    if (token !== playToken) return // 期间又跳了句，这次的播放交给新一轮
    if (stopped || mode !== 'chunk') return
  }

  function slotIndexOfSentence(index: number): number {
    return slots.findIndex((s) => s.kind === 'body' && s.sentenceIndex === index)
  }

  /** 回退到整章连播（只走一次，切回后不再判定回退） */
  function fallbackContinuous() {
    if (mode === 'continuous' || stopped) return
    mode = 'continuous'
    clearWatchdog()
    const a = ensureAudio()
    a.pause()
    for (const [i, u] of [...chunkUrls]) {
      URL.revokeObjectURL(u)
      chunkUrls.delete(i)
    }
    segments = buildSegments(lastChapter ?? ({} as AudioChapter), withTitle)
    slotIdx = -1
    cursor = 0
    a.src = lastUrl ?? ''
    a.playbackRate = rate
    a.defaultPlaybackRate = rate
    if (stopped) return
    void a.play().catch(() => {})
    if (!timer) startTimer()
  }

  // —— 回退模式的 tick：只看位置反查高亮，全程不写 currentTime ——
  const tick = () => {
    if (stopped || mode !== 'continuous' || !audio || segments.length === 0) return
    const t = (audio.currentTime || 0) * 1000
    const last = segments[segments.length - 1]
    if (t >= last.end + 2000) {
      finish()
      return
    }
    const i = activeSlotIndex(segments, t)
    if (i !== cursor && i >= 0) {
      cursor = i
      const seg = segments[i]
      if (seg.kind === 'body') cb.onSentence?.(seg.sentenceIndex)
      else if (seg.kind === 'title') cb.onTitle?.(seg.index)
      else cb.onNote?.(seg.noteId)
    }
  }

  const startTimer = () => {
    clearTimer()
    timer = window.setInterval(tick, 100)
  }

  // 回退要用的现场信息
  let lastChapter: AudioChapter | null = null
  let lastUrl = ''
  let withTitle = false

  const finish = () => {
    if (stopped) return
    stop()
    cb.onChapterEnd?.()
  }

  async function playChapter(opts: PlayChapterOptions): Promise<void> {
    cb = opts.callbacks
    rate = opts.rate && opts.rate > 0 ? opts.rate : 1
    lastChapter = opts.chapter
    lastUrl = opts.url
    withTitle = (opts.startSentenceIndex ?? 0) <= 0
    userPaused = false

    const a = ensureAudio()
    // 复位兜底：换 src / ended 续段时浏览器会把 playbackRate 复位到
    // defaultPlaybackRate（默认 1.0）。把它设成用户选的倍速，即便复位也复活成对的。
    // 设置面板的倍速只在这里读一次，所以「调节速 → 下次播放生效」天然满足。
    // TEMP-REVERT-CHECK
    a.defaultPlaybackRate = rate
    clearTimer()
    clearWatchdog()
    a.pause()
    a.src = ''
    stopped = true
    mode = 'chunk'
    segments = []
    slots = []
    bytes = null
    geo = null
    slotIdx = -1
    cursor = -1

    const bytesBuf = await loadChapterBytes(opts.url)
    if (bytesBuf) {
      const g = buildChapterGeometry(new Uint8Array(bytesBuf), opts.chapter.notesDurationMs)
      const s = buildChunkSlots(opts.chapter, withTitle)
      if (g && s.length > 0) {
        bytes = bytesBuf
        geo = g
        slots = s
      }
    }

    if (mode === 'chunk' && geo && slots.length > 0) {
      const startIdx = opts.startSentenceIndex ?? 0
      let target = 0
      if (startIdx > 0) {
        const i = slotIndexOfSentence(startIdx)
        if (i >= 0) target = i
      }
      stopped = false
      cb.onStatus?.('playing')
      await playSlot(target)
      return
    }

    // —— 回退：整章连播 ——
    mode = 'continuous'
    segments = buildSegments(opts.chapter, withTitle)
    if (segments.length === 0) {
      cb.onStatus?.('idle')
      return
    }
    a.src = opts.url
    a.playbackRate = rate
    a.defaultPlaybackRate = rate
    await new Promise<void>((resolve) => {
      a.addEventListener('loadedmetadata', () => {
        // 元数据到位后再补一次倍速：readyState 为 0 时赋值可能被忽略
        if (stopped || mode !== 'continuous') return
        a.playbackRate = rate
        resolve()
      }, { once: true })
      window.setTimeout(resolve, 2000)
    })
    cursor = 0
    stopped = false
    cb.onStatus?.('playing')
    emit(segments[0])
    startTimer()
    void a.play().catch(() => {})
  }

  const emit = (seg: Segment | undefined) => {
    if (!seg) return
    if (seg.kind === 'body') cb.onSentence?.(seg.sentenceIndex)
    else if (seg.kind === 'title') cb.onTitle?.(seg.index)
    else cb.onNote?.(seg.noteId)
  }

  function pause() {
    if (stopped) return
    userPaused = true
    ensureAudio().pause()
    cb.onStatus?.('paused')
  }

  function resume() {
    if (stopped) return
    userPaused = false
    void ensureAudio().play().catch(() => {})
    cb.onStatus?.('playing')
  }

  function stop() {
    stopped = true
    cursor = -1
    slotIdx = -1
    clearTimer()
    clearWatchdog()
    for (const [i, u] of [...chunkUrls]) {
      URL.revokeObjectURL(u)
      chunkUrls.delete(i)
    }
    if (audio) {
      audio.pause()
      audio.src = ''
    }
    cb.onStatus?.('idle')
  }

  function seekToSegment(seg: Segment | undefined) {
    if (!seg) return
    if (audio && audio.src) {
      const a = audio
      a.pause()
      a.addEventListener('seeked', () => emit(seg), { once: true })
      a.currentTime = seg.start / 1000
      return
    }
    emit(seg)
  }

  function seekToSentence(index: number) {
    if (mode === 'chunk') {
      const i = slotIndexOfSentence(index)
      if (i < 0) return
      if (stopped) {
        stopped = false
        cb.onStatus?.('playing')
      }
      void playSlot(i)
      return
    }
    const i = segments.findIndex((s) => s.kind === 'body' && s.sentenceIndex === index)
    if (i < 0) return
    cursor = i
    seekToSegment(segments[i])
  }

  function seekToTitle() {
    if (mode === 'chunk') {
      const i = slots.findIndex((s) => s.kind === 'title')
      if (i < 0) return
      if (stopped) {
        stopped = false
        cb.onStatus?.('playing')
      }
      void playSlot(i)
      return
    }
    const i = segments.findIndex((s) => s.kind === 'title')
    if (i < 0) return
    cursor = i
    seekToSegment(segments[i])
  }

  function seekToNote(noteId: string) {
    if (mode === 'chunk') {
      const i = slots.findIndex((s) => s.kind === 'note' && s.noteId === noteId)
      if (i < 0) return
      if (stopped) {
        stopped = false
        cb.onStatus?.('playing')
      }
      void playSlot(i)
      return
    }
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
