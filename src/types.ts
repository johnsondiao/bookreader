export type ThemeMode = 'day' | 'night' | 'eye'

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
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: ThemeMode
  ttsRate: number
  autoScroll: boolean
  /** 中文正文音色 key：lang||name */
  ttsVoiceZh: string
  /** 英文音色 */
  ttsVoiceEn: string
  /** 注释音色 */
  ttsVoiceNote: string
}

export type TabId = 'shelf' | 'history' | 'me'
export type Screen = 'home' | 'reader'
