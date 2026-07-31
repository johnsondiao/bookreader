import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import { createSampleBooks } from '../data/sampleBooks'
import type { Book, ProgressSnapshot, ReaderSettings, Screen, TabId } from '../types'
import { COVER_COLORS, calcProgress, guessTitleFromContent, parseChapters, splitParagraphs } from '../utils/chapterParser'

interface AppState {
  books: Book[]
  snapshots: ProgressSnapshot[]
  settings: ReaderSettings
  tab: TabId
  screen: Screen
  activeBookId: string | null
  showImportHint: boolean

  setTab: (tab: TabId) => void
  openBook: (bookId: string) => void
  closeReader: () => void
  importTextBook: (content: string, filename?: string) => string
  removeBook: (bookId: string) => void
  updateReadingProgress: (payload: {
    bookId: string
    chapterId: string
    paragraphIndex: number
    charOffset?: number
    source: 'read' | 'tts'
    note?: string
    recordSnapshot?: boolean
  }) => void
  updateSettings: (partial: Partial<ReaderSettings>) => void
  clearSnapshots: (bookId?: string) => void
  getBook: (id: string) => Book | undefined
}

const defaultSettings: ReaderSettings = {
  fontSize: 19,
  lineHeight: 1.85,
  theme: 'day',
  ttsRate: 1,
  autoScroll: true,
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      books: createSampleBooks(),
      snapshots: [],
      settings: defaultSettings,
      tab: 'shelf',
      screen: 'home',
      activeBookId: null,
      showImportHint: true,

      setTab: (tab) => set({ tab }),

      openBook: (bookId) => {
        set({
          activeBookId: bookId,
          screen: 'reader',
          books: get().books.map((b) => (b.id === bookId ? { ...b, lastReadAt: Date.now() } : b)),
        })
      },

      closeReader: () => set({ screen: 'home', activeBookId: null }),

      importTextBook: (content, filename) => {
        const chapters = parseChapters(content)
        const id = uuid()
        const color = COVER_COLORS[get().books.length % COVER_COLORS.length]
        const title = guessTitleFromContent(content, filename)
        const book: Book = {
          id,
          title,
          author: '本地导入',
          coverColor: color,
          coverEmoji: title.slice(0, 1) || '书',
          content,
          chapters,
          addedAt: Date.now(),
          lastReadAt: Date.now(),
          chapterId: chapters[0]?.id ?? '',
          paragraphIndex: 0,
          charOffset: 0,
          progressPercent: 0,
        }
        set({ books: [book, ...get().books], showImportHint: false })
        return id
      },

      removeBook: (bookId) => {
        set({
          books: get().books.filter((b) => b.id !== bookId),
          snapshots: get().snapshots.filter((s) => s.bookId !== bookId),
          activeBookId: get().activeBookId === bookId ? null : get().activeBookId,
          screen: get().activeBookId === bookId ? 'home' : get().screen,
        })
      },

      updateReadingProgress: ({ bookId, chapterId, paragraphIndex, charOffset = 0, source, note, recordSnapshot = true }) => {
        const book = get().books.find((b) => b.id === bookId)
        if (!book) return
        const chapterIndex = book.chapters.findIndex((c) => c.id === chapterId)
        const chapter = book.chapters[chapterIndex]
        if (!chapter) return
        const paras = splitParagraphs(chapter.content)
        const progressPercent = calcProgress(chapterIndex, book.chapters.length, paragraphIndex, paras.length)

        const snapshot: ProgressSnapshot | null = recordSnapshot
          ? {
              id: uuid(),
              bookId,
              chapterId,
              chapterTitle: chapter.title,
              paragraphIndex,
              charOffset,
              progressPercent,
              source,
              note,
              createdAt: Date.now(),
            }
          : null

        set({
          books: get().books.map((b) =>
            b.id === bookId
              ? {
                  ...b,
                  chapterId,
                  paragraphIndex,
                  charOffset,
                  progressPercent,
                  lastReadAt: Date.now(),
                }
              : b,
          ),
          snapshots: snapshot ? [snapshot, ...get().snapshots].slice(0, 500) : get().snapshots,
        })
      },

      updateSettings: (partial) => set({ settings: { ...get().settings, ...partial } }),

      clearSnapshots: (bookId) =>
        set({
          snapshots: bookId ? get().snapshots.filter((s) => s.bookId !== bookId) : [],
        }),

      getBook: (id) => get().books.find((b) => b.id === id),
    }),
    {
      name: 'langyue-reader-v1',
      partialize: (s) => ({
        books: s.books,
        snapshots: s.snapshots,
        settings: s.settings,
        showImportHint: s.showImportHint,
      }),
    },
  ),
)
