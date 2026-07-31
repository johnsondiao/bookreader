export type ThemeMode = 'day' | 'night' | 'eye'

export interface Chapter {
  id: string
  title: string
  startIndex: number
  content: string
}

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
  addedAt: number
  lastReadAt: number
  /** 当前阅读/朗读进度 */
  chapterId: string
  paragraphIndex: number
  charOffset: number
  progressPercent: number
}

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: ThemeMode
  ttsRate: number
  autoScroll: boolean
}

export type TabId = 'shelf' | 'history' | 'me'
export type Screen = 'home' | 'reader'
