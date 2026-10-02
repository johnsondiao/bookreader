/**
 * 把一章 mp3 按 manifest 的时间轴切成一个个「独立可播的小段」。
 *
 * ## 为什么要切句播放（而不是整章一条流播到底）
 *
 * 原方案：整章 mp3 从头连读到尾，靠上报的 `currentTime` 反查「现在该高亮哪一句」。
 * 风险在于只要播放器做过一次 seek（跳句、跳注释），Android WebView 的
 * `currentTime` 是媒体时钟阶梯值 + 输出缓冲滞后 200~300ms，seek 回段首就会把
 * 该句开头已经念过的字再念一遍 —— 听感「每句开头重复一个字」。
 *
 * 新方案（本模块 + audioPlayer 的 chunk 模式）：
 *   ① 解析 mp3 帧结构，把「毫秒」换算成「字节偏移」（mp3 是 CBR，帧长固定，
 *      时间 ↔ 字节 是严格线性的）；
 *   ② 按 manifest 划出每一段的物理区间 —— **第 i 段的区间 = [本段开头, 下一段开头)**，
 *      也就是用户念的「这一句开头到下一句开头之间那块数据」；
 *   ③ 每次只把这一段的字节 `Blob.slice()` 出来给 `<audio>`，播完再换下一段。
 *
 * 这样「重复」从原理上不可能发生：播的是**精确的一段字节**，起点就是这句的
 * 第一帧，根本不存在「把上一句尾巴 + 下一句开头一起读进来」的可能。
 *
 * mp3 帧结构要点（双精度检查，避免硬编码码率/采样率导致切偏）：
 *   - 帧头 4 字节：`0xFF 0xFB` 之类，第 2 字节的 bit 3/2 = MPEG 版本，bit 1/0 = 层
 *   - Layer III：MPEG1 每帧 1152 samples / 帧，MPEG2/2.5 每帧 576 samples / 帧
 *   - 帧长（字节）= floor(帧内采样数 / 8 × 码率 / 采样率) + padding
 *   - 帧时长（秒）= 帧内采样数 / 采样率
 * 例：32kbps @16kHz 的 MPEG2 Layer III → 576 samples/帧、144 字节/帧、36ms/帧。
 *
 * 帧边界对齐很重要：切片必须从**完整帧的开头**切，切在帧中间会让解码器丢帧；
 * 段尾则允许多带不满一帧的量（<= 一帧 ≈ 36ms，是句尾静音，听不出来）。
 */
import type { AudioChapter } from '../types'

/** 从 mp3 头部解出的帧结构 */
export interface MpegFrameInfo {
  /** 单帧字节数（已含 padding 位） */
  frameLen: number
  sampleRate: number
  /** 一帧含多少采样点：MPEG1 Layer III = 1152，MPEG2/2.5 = 576 */
  samplesPerFrame: number
  /** 第一个帧在整章里的字节偏移（跳过 ID3v2 tag） */
  offset: number
}

/** 读一个帧头；不在帧同步上就返回 null */
function headerAt(bytes: Uint8Array, off: number) {
  if (off < 0 || off + 4 > bytes.length) return null
  if (bytes[off] !== 0xff || (bytes[off + 1] & 0xe0) !== 0xe0) return null
  const b1 = bytes[off + 1]
  const b2 = bytes[off + 2]
  const versionBits = (b1 >> 3) & 3
  const layerBits = (b1 >> 1) & 3
  if (layerBits !== 1) return null // 只认 Layer III
  const bitIdx = (b2 >> 4) & 0xf
  const srIdx = (b2 >> 2) & 0x3
  const padding = (b2 >> 1) & 0x1
  if (bitIdx === 0 || bitIdx === 15 || srIdx === 3) return null
  const mpeg1 = versionBits === 3
  const bitrateKbps = mpeg1 ? BITRATE_V1[bitIdx] : BITRATE_V2[bitIdx]
  const sampleRate = mpeg1 ? SAMPLE_RATE_V1[srIdx] : versionBits === 2 ? SAMPLE_RATE_V2[srIdx] : SAMPLE_RATE_V25[srIdx]
  if (!bitrateKbps || !sampleRate) return null
  const samplesPerFrame = mpeg1 ? 1152 : 576
  // 帧长（字节）= 帧时长(秒) × 码率(字节/秒)；码率表单位 kbps，×1000 得 bit/s 后再 ÷8
  const frameLen = Math.floor((samplesPerFrame / sampleRate) * ((bitrateKbps * 1000) / 8)) + padding
  return frameLen < 24 ? null : { frameLen, sampleRate, samplesPerFrame }
}

/** 一章 mp3 的几何信息：帧结构 + 帧数 + 推算时长 */
export interface ChapterGeometry {
  frames: MpegFrameInfo
  frameCount: number
  /** 整章 mp3 字节数 */
  size: number
  /** 按帧结构推算的整章时长（ms） */
  durationMs: number
  /** 第一帧的实际字节数（真包实测首帧 180、其余 144；frames.frameLen 是全章统一帧长） */
  firstFrameLen: number
  /**
   * 音频内容相对「帧时间轴」的前导量（ms）。
   *
   * 三种东西会占掉帧时间轴却不含正文声音：
   *   ① 首帧的 Xing/Info 元数据帧（真包首帧 180 字节那个，占 1 帧 = 36ms）；
   *   ② LAME/ffmpeg 的编码器前导延迟（实测 2 帧 = 72ms）。
   * 不补掉它，切出来的每一段都会比 manifest 标的位置**早 ~108ms**，段尾就把
   * 下一句的开头带进来念了（听感「下一句前几个字被上一句念走」）。
   */
  leadMs: number
}

/** MPEG1 Layer III 码率表（kbps，索引 = bitrate_index，0 为 free） */
const BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
/** MPEG2 / MPEG2.5 Layer III 码率表（kbps） */
const BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATE_V1 = [44100, 48000, 32000, 0]
const SAMPLE_RATE_V2 = [22050, 24000, 16000, 0]
const SAMPLE_RATE_V25 = [11025, 12000, 8000, 0]

/** 定位第一个 MPEG 帧并返回它的帧结构；解析不出来（非 mp3 / 头损坏）返回 null */
export function parseMpegFrame(bytes: Uint8Array, from = 0): MpegFrameInfo | null {
  const info = findFirstFrame(bytes, from)
  return info ? { ...info, offset: info.offset } : null
}

/** 内部：找到第一个帧并解出帧结构（不含 offset 语义差异） */
function findFirstFrame(bytes: Uint8Array, from = 0) {
  let off = from
  // 跳过 ID3v2 tag：'ID3' + 版本 + _flags + 4 字节 syncsafe 长度
  if (bytes.length - off > 10 && bytes[off] === 0x49 && bytes[off + 1] === 0x44 && bytes[off + 2] === 0x33) {
    const size =
      ((bytes[off + 6] & 0x7f) << 21) | ((bytes[off + 7] & 0x7f) << 14) | ((bytes[off + 8] & 0x7f) << 7) | (bytes[off + 9] & 0x7f)
    off += 10 + size
  }
  // 找帧同步字 11 位 1
  for (let i = off; i + 4 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const versionBits = (b1 >> 3) & 3 // 3 = MPEG1, 2 = MPEG2, 1 = reserved, 0 = MPEG2.5
    const layerBits = (b1 >> 1) & 3 // 3 = Layer I, 2 = Layer II, 1 = Layer III, 0 = reserved
    if (layerBits !== 1) break // 只认 Layer III
    const bitIdx = (b2 >> 4) & 0xf
    const srIdx = (b2 >> 2) & 0x3
    const padding = (b2 >> 1) & 0x1
    if (bitIdx === 0 || bitIdx === 15 || srIdx === 3) continue
    const mpeg1 = versionBits === 3
    const bitrateKbps = mpeg1 ? BITRATE_V1[bitIdx] : BITRATE_V2[bitIdx]
    const sampleRate = mpeg1 ? SAMPLE_RATE_V1[srIdx] : versionBits === 2 ? SAMPLE_RATE_V2[srIdx] : SAMPLE_RATE_V25[srIdx]
    if (!bitrateKbps || !sampleRate) continue
    const samplesPerFrame = mpeg1 ? 1152 : 576
    // 帧长（字节）= 帧时长(秒) × 码率(字节/秒) ；码率表单位是 kbps，先 ×1000 得 bit/s 再 ÷8
    const bytesPerSec = (bitrateKbps * 1000) / 8
    const frameLen = Math.floor((samplesPerFrame / sampleRate) * bytesPerSec) + padding
    if (frameLen < 24) continue
    return { frameLen, sampleRate, samplesPerFrame, offset: i }
  }
  return null
}

/** 该位置是不是一个 mp3 帧同步点 */
function isSync(bytes: Uint8Array, off: number): boolean {
  return off >= 0 && off + 2 <= bytes.length && bytes[off] === 0xff && (bytes[off + 1] & 0xe0) === 0xe0
}

/**
 * 从某个帧长出发，沿着「帧长等距前进」走到底；只要中途踩不到帧同步就说明帧长猜对了。
 * 返回帧数；断链返回 -1。
 */
function countChain(bytes: Uint8Array, offset: number, frameLen: number): number {
  let off = offset
  let n = 0
  while (off + 4 <= bytes.length) {
    if (!isSync(bytes, off)) return -1
    off += frameLen
    n++
  }
  return n
}

/** 兜底：整章扫一遍，统计哪种帧长出现最多（真包首帧 180、其余 144 靠这个也能认出来） */
function dominantFrameLen(bytes: Uint8Array, start: number): number {
  const hist = new Map<number, number>()
  let off = start
  let guard = 0
  while (off + 4 <= bytes.length && guard++ < 1_000_000) {
    if (isSync(bytes, off)) {
      const h = headerAt(bytes, off)
      if (h) {
        hist.set(h.frameLen, (hist.get(h.frameLen) ?? 0) + 1)
        off += h.frameLen
        continue
      }
    }
    off++
  }
  let best = -1
  let bestN = 0
  for (const [len, n] of hist) {
    if (n > bestN) {
      bestN = n
      best = len
    }
  }
  return best
}

/**
 * 建立整章的「时间 ↔ 字节」映射。
 *
 * 不能只信第一帧头里的帧长：实测真包（毛选 ch-3）第一帧是 180 字节 / 40kbps，
 * 其余十万多个帧全是 144 字节 / 32kbps —— 直接拿首帧当统一帧长会让整章时间轴
 * 偏 25%，句级切片全部错位。所以这里走「链校验」：
 *   ① 先用首帧头解出候选帧长；
 *   ② 再用 manifest 的整章时长反推一个候选帧长；
 *   ③ 逐个候选试「等距走到底不断链」，谁先走得通就用谁，帧数即真实帧数。
 * 最后时长由「帧数 × 每帧采样点数 / 采样率」算出，天然吃掉 LAME 尾部 padding。
 */
/**
 * 首帧是不是 Xing/Info 元数据帧（ffmpeg 写的 Xing 头里带 "Info"/"Xing" 字样）。
 * 这种帧占满一帧的字节，但里面装的是表头不是声音。
 */
function isXingFrame(bytes: Uint8Array, info: MpegFrameInfo): boolean {
  const end = Math.min(bytes.length, info.offset + Math.min(info.frameLen, 64))
  for (let i = info.offset; i + 4 <= end; i++) {
    const tag = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3])
    if (tag === 'Xing' || tag === 'Info') return true
  }
  return false
}

/** 编码器前导延迟有几帧：ffmpeg/libmp3lame 固定 2 帧（实测 108ms 前导里的 72ms） */
const ENCODER_DELAY_FRAMES = 2

export function buildChapterGeometry(bytes: Uint8Array, notesDurationMs?: number): ChapterGeometry | null {
  const first = parseMpegFrame(bytes)
  if (!first) return null
  const audioBytes = bytes.length - first.offset
  // 第一帧的长度可能和全章不一样（真包实测首帧 180 字节，其余全是 144）
  const tailStart = first.offset + first.frameLen

  const candidates = [first.frameLen]
  if (notesDurationMs && notesDurationMs > 0) {
    const estFrames = Math.round(((notesDurationMs / 1000) * first.sampleRate) / first.samplesPerFrame)
    if (estFrames > 4) {
      const derived = Math.round(audioBytes / estFrames)
      if (derived > 12) candidates.push(derived)
    }
  }
  candidates.push(dominantFrameLen(bytes, tailStart))

  for (const frameLen of candidates) {
    if (frameLen < 12) continue
    const n = countChain(bytes, tailStart, frameLen)
    if (n < 3) continue
    const frameCount = n + 1 // 加回第一帧
    // 走到底后必须几乎用满整章字节（允许尾部 padding 差 2 帧）
    const covered = frameCount * frameLen
    if (audioBytes - covered > 2 * frameLen || covered - audioBytes > 2 * frameLen) continue
    const durationMs = ((frameCount * first.samplesPerFrame) / first.sampleRate) * 1000
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue
    const msPerFrame = (first.samplesPerFrame / first.sampleRate) * 1000
    // 元数据帧自己占 1 帧；前面再垫 ENCODER_DELAY_FRAMES 帧静音。
    // 已剥掉前导的新包没有 Xing 帧，leadMs 就是 0，什么都不补。
    const leadFrames = (isXingFrame(bytes, first) ? 1 : 0) + ENCODER_DELAY_FRAMES
    const leadMs = isXingFrame(bytes, first) ? leadFrames * msPerFrame : 0
    return {
      frames: { ...first, frameLen },
      frameCount,
      size: bytes.length,
      durationMs,
      firstFrameLen: first.frameLen,
      leadMs,
    }
  }
  return null
}

/**
 * 第 `fi` 帧在整章里的字节起点。
 *
 * 必须把「第一帧长度 ≠ 全章帧长」算进去（真包首帧 180 字节、其余 144）：
 * 否则 fi>=1 的起点会全部落在第一帧内部，解码器丢帧，句首吃掉一帧、句间静音少 36ms
 * —— 听感不明显「快」，但会明显「赶」。
 */
function frameStartAt(geo: ChapterGeometry, fi: number): number {
  const { frames } = geo
  if (fi <= 0) return frames.offset
  return frames.offset + geo.firstFrameLen + (fi - 1) * frames.frameLen
}

/**
 * 把「毫秒」换算成整章里的字节偏移（帧边界对齐）。
 *
 * 用**绝对帧时长**推导（`ms / 每帧时长`），而不是拿整章时长做比例 —— 比例映射会把
 * manifest 与音频之间的固定前导均匀摊到全章，摊不掉反而引入随位置变化的漂移。
 *
 * `leadMs`（前导补偿）必须加上：见 `buildChapterGeometry` 里的说明。
 */
export function byteAtMs(geo: ChapterGeometry, ms: number): number {
  const { frames, frameCount, size } = geo
  const msPerFrame = (frames.samplesPerFrame / frames.sampleRate) * 1000
  const t = ms + geo.leadMs
  const fi = Math.max(0, Math.min(Math.round(t / msPerFrame), frameCount - 1))
  const start = frameStartAt(geo, fi)
  return Math.max(0, Math.min(start, size))
}

/** 某个时间点的段在整章里的字节区间（左闭右开，右端允许多带一帧） */
export function byteRange(geo: ChapterGeometry, startMs: number, endMs: number) {
  const start = byteAtMs(geo, startMs)
  const end = Math.max(start + geo.frames.frameLen, byteAtMs(geo, endMs))
  return { start, end: Math.min(end, geo.size) }
}

// ───────────────────────── 段序列 ─────────────────────────

export type ChunkSlot =
  | { kind: 'title'; startMs: number; endMs: number; index: number; cutStartMs: number; cutEndMs: number }
  | { kind: 'body'; startMs: number; endMs: number; sentenceIndex: number; cutStartMs: number; cutEndMs: number }
  | { kind: 'note'; startMs: number; endMs: number; noteId: string; cutStartMs: number; cutEndMs: number }

/** 一个待播的「体」：标题 / 一句正文 / 一条注释 */
type Item =
  | { kind: 'title'; startMs: number; endMs: number; voiceEndMs: number }
  | { kind: 'body'; startMs: number; endMs: number; voiceEndMs: number; sentenceIndex: number }
  | { kind: 'note'; startMs: number; endMs: number; voiceEndMs: number; noteId: string }

/**
 * 段首「借位预热」的上限（ms）。
 *
 * 切出来的每一段 mp3 都被解码器**从零开始解**：它要回前面几十字节去取本帧的主数据
 * （MP3 的比特蓄水池，实测 side_info 的 main_data_begin 回溯 26~96 字节，帧长 144
 * 字节，所以相当于缺了 0.2~0.7 帧的主数据），而切片前面什么都没有 —— 于是段首
 * 1~2 帧解不出东西，听感就是每句开头一声极短的「呲」（本包实测：句首 40ms RMS 全 0，
 * 8/8 句都这样）。
 *
 * 修法：把切点从「这句的第一个字」往前挪到「上一句说完」的位置。文件里那段本来
 * 就是**真静音**（合成时留的句间停顿，实测最短 120ms、中位 500ms、100% ≥ 72ms），
 * 拿它给解码器当预热，句首就干净了；不额外占空间、不改变时长、句间停顿还是原样。
 *
 * 上限只是防呆：万一某句后面跟了超长空白，别把一大段静音都塞进段首。
 */
const MAX_LEAD_IN_MS = 1200

/**
 * 段尾保护（ms）：切点落在「这句念完」之后再留一点余量。
 *
 * manifest 的 voiceEndMs 是引擎给最后一个字的时间戳，实际声波尾巴还会再响十几毫秒；
 * 掐得太准会削掉韵尾。留一帧多（36ms）的余量，这截余量落在句间静音里，听不出来。
 */
const TAIL_GUARD_MS = 40

/** 取一个可靠的「语音结束」时刻：voiceEndMs 缺失或为 0 时退回 endMs */
function voiceEndOf(v: number | undefined | null, fallback: number): number {
  return typeof v === 'number' && v > 0 ? v : fallback
}

/**
 * 把一章摊成按时间升序的播放段。
 *
 * **逻辑区间**（用于排序 / 高亮 / 零长度判定）沿用老规则：`[本段开头, 下一段开头)`。
 *
 * **物理区间**（切字节用）另算一套：把切点挪进句间静音里 ——
 *   段 i 的物理区间 = `[上一个切点, 本段切点)`，切点落在「本句念完 + 一点余量」
 *   与「下一句开口」之间的那段静音里。
 * 于是每段开头自带一段真静音当解码器预热，句首不再有「呲」声；切点被相邻两段
 * 共享，既不重叠（同一段字节播两次）也不越界（削掉下一个字）。
 */
export function buildChunkSlots(chapter: AudioChapter, withTitle: boolean): ChunkSlot[] {
  // 小于这个值（1 帧 = 36ms 的两倍多）的段不单独播：见下面「零长度句」的说明
  const MIN_SLOT_MS = 80

  const items: Item[] = []
  const ts = chapter.titleStartMs ?? 0
  const te = chapter.titleEndMs ?? ts
  if (withTitle && te > ts) {
    items.push({ kind: 'title', startMs: ts, endMs: te, voiceEndMs: te })
  }

  const notes = chapter.notes.filter((n) => n.startMs != null && n.endMs != null)
  const chapterEndMs = chapter.notesDurationMs ?? 0

  chapter.sentences.forEach((s, i) => {
    const start = s.startMs
    // 下一句的开头 / 下一条注释的开头 / 整章时长 —— 谁先来用谁
    const nextNote = notes.find((n) => (n.startMs ?? 0) > start)
    const nextSentence = chapter.sentences[i + 1]
    const endMs = nextSentence?.startMs ?? nextNote?.startMs ?? chapterEndMs ?? start
    // 跳过「零长度句」：manifest 里有一批时长为 0 的句子，文本是纯标点/标记
    // （… 、”、〔2〕、）、* * * 之类）。TTS 对它们不发声，所以 startMs == endMs，
    // 给它切段只能切出 1 帧（36ms），听感是「下一句开头的一小截 + 停顿 + 重念」。
    // 这类句子不产生声音，不排进播放序列；文本照常显示在屏幕上。
    if (endMs - start < MIN_SLOT_MS) return
    items.push({ kind: 'body', startMs: start, endMs, voiceEndMs: s.voiceEndMs ?? s.endMs, sentenceIndex: s.index ?? i })
  })

  notes.forEach((n, i) => {
    const next = notes[i + 1]
    const endMs = next?.startMs ?? chapterEndMs ?? (n.endMs ?? 0)
    if (endMs - (n.startMs ?? 0) < MIN_SLOT_MS) return // 同上，零长度注释不单独成段
    const startMs = n.startMs!
    items.push({ kind: 'note', startMs, endMs, voiceEndMs: n.voiceEndMs ?? n.endMs ?? startMs, noteId: n.id })
  })

  items.sort((a, b) => a.startMs - b.startMs)

  // 语音结束时刻（voiceEndMs 是引擎给「最后一个字」的时间戳，声波尾巴还会再响一会儿）
  const voiceEnds = items.map((it) => Math.max(voiceEndOf(it.voiceEndMs, it.endMs), it.startMs))

  // —— 先算出每两个相邻段之间的**切点** ——
  //
  // 切点必须落在「本句念完」与「下一句开口」之间的那段静音里，而且**被相邻两段共享**：
  //   · ≥ 本句 voiceEnd + 余量 → 不削掉本句的韵尾
  //   · ≤ 下一句 startMs      → 不切进下一句的字（那正是当初「抢字」的成因）
  //   · 静音太长时后移到「只留 MAX_LEAD_IN_MS 预热」→ 不灌几十秒白噪音
  // 共享切点 = 既不重叠（不会有字被念两遍），也不留缝（不会有字永远播不到）。
  const cuts: number[] = []
  for (let k = 0; k + 1 < items.length; k++) {
    const latest = items[k + 1].startMs
    const earliest = Math.min(voiceEnds[k], latest) // 绝不削掉本句尾巴
    let cut = Math.min(voiceEnds[k] + TAIL_GUARD_MS, latest)
    cut = Math.max(cut, earliest)
    cut = Math.min(Math.max(cut, latest - MAX_LEAD_IN_MS), latest)
    cuts.push(cut)
  }

  // —— 再用切点拼出各段的物理区间 ——
  const slots: ChunkSlot[] = []
  for (let k = 0; k < items.length; k++) {
    const it = items[k]
    // 第一段从逻辑起点起（没「上一句」可借）；最后一段封到本章结束
    const cutStart = k === 0 ? it.startMs : cuts[k - 1]
    const cutEnd = k === items.length - 1 ? Math.max(voiceEnds[k] + TAIL_GUARD_MS, it.endMs) : cuts[k]
    if (cutEnd <= cutStart) continue
    if (it.kind === 'title') {
      slots.push({ kind: 'title', startMs: it.startMs, endMs: it.endMs, index: -1, cutStartMs: cutStart, cutEndMs: cutEnd })
    } else if (it.kind === 'body') {
      slots.push({ kind: 'body', startMs: it.startMs, endMs: it.endMs, sentenceIndex: it.sentenceIndex, cutStartMs: cutStart, cutEndMs: cutEnd })
    } else {
      slots.push({ kind: 'note', startMs: it.startMs, endMs: it.endMs, noteId: it.noteId, cutStartMs: cutStart, cutEndMs: cutEnd })
    }
  }
  return slots
}

