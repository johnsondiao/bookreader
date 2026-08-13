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
  source: 'read' | 'tts'
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
  /** 自动重分章已尝试过的算法版本号（避免无法切分的书每次启动重复全文解析；算法升级时 bump 版本可重试） */
  chapterizeTryVersion?: number
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: ThemeMode
  ttsRate: number
  autoScroll: boolean
  /** 睡眠定时（分钟）：记住上次设置的时长，0=关闭 */
  ttsSleepMinutes?: number
  /** 中文正文音色 key：lang||name */
  ttsVoiceZh: string
  /** 注释音色 */
  ttsVoiceNote: string
  /** 调试面板默认是否展开（默认 false，不展开） */
  ttsDebugPanel?: boolean
  /** 每日花费预算上限（元），0 表示不限制 */
  dailyBudgetYuan?: number
}

/** 已合成的整章 MP3 文件元数据（外部存储 index.json 中的一项） */
export interface AudioFileRecord {
  /** 稳定唯一 key：bookId__chapterId__voiceCombo（正文音色|注释音色） */
  id: string
  bookId: string
  bookTitle: string
  chapterId: string
  chapterTitle: string
  /** 正文音色 key（ttsVoices.ts） */
  voiceKey: string
  /** 注释音色 key，若没有则与 voiceKey 相同 */
  noteVoiceKey: string
  /** 展示名："温润男声 - 精英青年注释" */
  voiceLabel: string
  /** 正文哈希：正文变化了缓存自动作废 */
  textHash: string
  /** 该音频覆盖的字符区间 [charStart, charEnd) */
  charStart: number
  charEnd: number
  /** 文件名：结构化命名，含 bookId/chapterId/音色/字符区间/hash，可从文件名重建索引 */
  fileName: string
  /** 文件大小（字节） */
  sizeBytes: number
  /** 合成时间（ms timestamp） */
  createdAt: number
}


export type TabId = 'shelf' | 'history' | 'cost' | 'me'
export type Screen = 'home' | 'reader'
