import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import { createSampleBooks } from '../data/sampleBooks'
import type { Book, Chapter, ProgressSnapshot, ReaderSettings, Screen, TabId, TocEntry } from '../types'
import type { ParsedEbook } from '../utils/epubParser'
import { bindTocToChapters, tocFromChapters } from '../utils/epubParser'
import { COVER_COLORS, calcProgress, guessTitleFromContent, parseChapters, splitParagraphs } from '../utils/chapterParser'
import { createIdbStorage } from '../utils/idbStorage'

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
  importParsedBook: (parsed: ParsedEbook) => string
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

function normalizeBook(book: Book): Book {
  const chapters = book.chapters || []
  let toc = book.toc
  if (!toc?.length) {
    toc = tocFromChapters(chapters)
  } else if (chapters.length && toc.some((t) => !t.chapterId)) {
    toc = bindTocToChapters(
      toc.map((t) => ({ title: t.title, level: t.level ?? 0, href: t.href || '' })),
      chapters,
    )
    // 仍全部无法匹配则退回章节目录
    if (toc.every((t) => !t.chapterId)) {
      toc = tocFromChapters(chapters)
    }
  }
  const readChapterIds = book.readChapterIds || []
  const fromCurrent = chapters.findIndex((c) => c.id === book.chapterId)
  const furthestChapterIndex =
    typeof book.furthestChapterIndex === 'number'
      ? book.furthestChapterIndex
      : Math.max(0, fromCurrent)
  return {
    ...book,
    content: '',
    toc,
    readChapterIds,
    furthestChapterIndex: furthestChapterIndex < 0 ? 0 : furthestChapterIndex,
  }
}

function buildBook(parsed: {
  title: string
  author: string
  content?: string
  chapters: { title: string; startIndex: number; content: string; href?: string }[]
  toc?: { title: string; level: number; href: string }[]
  coverColor: string
}): Book {
  const chapters: Chapter[] = parsed.chapters.map((c, i) => ({
    id: `ch-${i}`,
    title: c.title,
    startIndex: c.startIndex,
    content: c.content,
    href: c.href,
  }))

  const tocRaw = parsed.toc?.length
    ? parsed.toc
    : chapters.map((c) => ({ title: c.title, level: 0, href: c.href || '' }))
  const toc: TocEntry[] = bindTocToChapters(tocRaw, chapters)

  return {
    id: uuid(),
    title: parsed.title,
    author: parsed.author,
    coverColor: parsed.coverColor,
    coverEmoji: parsed.title.slice(0, 1) || '书',
    content: '',
    chapters,
    toc,
    addedAt: Date.now(),
    lastReadAt: Date.now(),
    chapterId: chapters[0]?.id ?? '',
    paragraphIndex: 0,
    charOffset: 0,
    progressPercent: 0,
    furthestChapterIndex: 0,
    readChapterIds: chapters[0] ? [chapters[0].id] : [],
  }
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
        const title = guessTitleFromContent(content, filename)
        const book = buildBook({
          title,
          author: '本地导入',
          content,
          chapters,
          coverColor: COVER_COLORS[get().books.length % COVER_COLORS.length],
        })
        set({ books: [book, ...get().books], showImportHint: false })
        return book.id
      },

      importParsedBook: (parsed) => {
        const book = buildBook({
          title: parsed.title,
          author: parsed.author,
          chapters: parsed.chapters,
          toc: parsed.toc,
          coverColor: COVER_COLORS[get().books.length % COVER_COLORS.length],
        })
        set({ books: [book, ...get().books], showImportHint: false })
        return book.id
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

        const readChapterIds = [...new Set([...(book.readChapterIds || []), chapterId])]
        const furthestChapterIndex = Math.max(book.furthestChapterIndex ?? 0, chapterIndex)

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
                  readChapterIds,
                  furthestChapterIndex,
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
      name: 'langyue-reader-v2',
      storage: createIdbStorage(),
      partialize: (s) => ({
        books: s.books.map((b) => ({ ...b, content: '' })),
        snapshots: s.snapshots,
        settings: s.settings,
        showImportHint: s.showImportHint,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<AppState> | undefined
        if (!p) return current
        return {
          ...current,
          ...p,
          books: (p.books ?? current.books).map((b) => normalizeBook(b as Book)),
        }
      },
    },
  ),
)
