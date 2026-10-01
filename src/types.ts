export type ThemeMode = 'day' | 'eye' | 'paper' | 'green' | 'pink' | 'night'

/** 阅读器背景主题选项（新增主题时同步 index.css 的 .reader.theme-* 与 .theme-pills 色块） */
export const READER_THEMES: { key: ThemeMode; label: string }[] = [
  { key: 'day', label: '日间' },
  { key: 'eye', label: '护眼' },
  { key: 'paper', label: '羊皮纸' },
  { key: 'green', label: '青绿' },
  { key: 'pink', label: '樱粉' },
  { key: 'night', label: '夜间' },
]

export interface Chapter {
  id: string
  title: string
  startIndex: number
  content: string
  /** EPUB spine 文件路径，用于目录跳转匹配 */
  href?: string
}

/** 扁平化目录项（带层级），来自 EPUB nav/NCX 或由章节生成 */
export interface TocEntry {
  id: string
  title: string
  /** 0=卷/部，1=章，2=节… */
  level: number
  /** 对应正文章节；无法匹配时为 null */
  chapterId: string | null
  href: string
}

export type TocReadStatus = 'unread' | 'reading' | 'read'

export interface ProgressSnapshot {
  id: string
  bookId: string
  chapterId: string
  chapterTitle: string
  paragraphIndex: number
  charOffset: number
  progressPercent: number
  source: 'read' | 'audio'
  note?: string
  createdAt: number
}

export interface Book {
  id: string
  title: string
  author: string
  coverColor: string
  coverEmoji: string
  content: string
  chapters: Chapter[]
  /** 结构化目录；缺省时由 chapters 生成 */
  toc: TocEntry[]
  addedAt: number
  lastReadAt: number
  chapterId: string
  paragraphIndex: number
  charOffset: number
  progressPercent: number
  /** 读到过的最远章节下标（含），用于目录已读着色 */
  furthestChapterIndex: number
  /** 实际打开过的章节 id */
  readChapterIds: string[]
  /**
   * 音频包索引：chapterId → 该章音频元数据（含句级偏移）。
   * 有音频的章节阅读时渲染 manifest 里的句子/注释；无音频章节走纯文本。
   */
  audioChapters?: Record<string, AudioChapter>
  /** 已有音频的章节数（书架显示「已导入音频 N 章」） */
  audioChapterCount?: number
  /** 自动重分章已尝试过的算法版本号（TXT 单巨章书用） */
  chapterizeTryVersion?: number
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: ThemeMode
  /** 音频播放语速（0.6~1.8） */
  playbackRate: number
  autoScroll: boolean
  /** 翻页方式：scroll=上下滚动（默认），flip=左右翻页 */
  pagingMode?: 'scroll' | 'flip'
  /** 睡眠定时（分钟）：记住上次设置的时长，0=关闭 */
  sleepMinutes?: number
}

export type TabId = 'shelf' | 'history' | 'me'
export type Screen = 'home' | 'reader'

/* ============================= 音频包（PC 端导出） ============================= */

/** 音频包内正文句：与章节 mp3 正文段按 startMs/endMs 对齐 */
export interface AudioSentence {
  index: number
  text: string
  kind: 'text'
  /** 定位区间（句间连续） */
  startMs: number
  endMs: number
  /** 真实语音区间（高亮用，跳过静音） */
  voiceStartMs: number
  voiceEndMs: number
  /** 本句所含注释标记，指向 notes[].id */
  noteRef?: string[]
}

/** 音频包内注释（脚注），音频位于正文段之后 */
export interface AudioNote {
  id: string
  index: number
  text: string
  kind: 'note'
  startMs: number
  endMs: number
  voiceStartMs: number
  voiceEndMs: number
}

/** 单章音频元数据（manifest.chapters[] 的一项） */
export interface AudioChapter {
  id: string
  title: string
  /** 正文时长（= 末句 endMs） */
  durationMs: number
  sentenceCount: number
  sentences: AudioSentence[]
  notes: AudioNote[]
  /** 含注释段的整章文件时长 */
  notesDurationMs: number
}

/** manifest.json 结构（docs/audio-package-format.md） */
export interface AudioManifest {
  format: string
  version: number
  generator?: string
  createdAt?: string
  package: {
    mode: 'full' | 'partial'
    chapterIds: string[]
    sourceChapterCount: number
    batch?: number
  }
  book: {
    id: string
    title: string
    author?: string
    sourceFile: string
    sourceFormat: 'epub' | 'txt'
    voice?: { label?: string; voiceId?: number; engine?: string }
    noteVoice?: { label?: string; voiceId?: number; engine?: string }
  }
  chapters: AudioChapter[]
  integrity?: {
    chapterCount?: number
    sentenceCount?: number
    noteCount?: number
    totalBytes?: number
    sourceHash?: string
  }
}
