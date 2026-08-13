import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { Book, Chapter, ProgressSnapshot, ReaderSettings, Screen, TabId, TocEntry } from '../types'
import type { ParsedEbook } from '../utils/epubParser'
import { bindTocToChapters, tocFromChapters } from '../utils/epubParser'
import { COVER_COLORS, calcProgress, guessTitleFromContent, parseChapters, splitParagraphTexts } from '../utils/chapterParser'
import { createIdbStorage } from '../utils/idbStorage'
import { DEFAULT_VOICE_NOTE, DEFAULT_VOICE_ZH } from '../utils/ttsVoices'

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
  ttsVoiceZh: DEFAULT_VOICE_ZH,
  ttsVoiceNote: DEFAULT_VOICE_NOTE,
}

function normalizeBook(book: Book): Book {
  // 单巨章书籍自动重分章（旧导入的无目录网文也能生成目录）
  const b = autoChapterizeIfNeeded(book) ?? book
  const chapters = b.chapters || []
  let toc = b.toc
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
  const readChapterIds = b.readChapterIds || []
  const fromCurrent = chapters.findIndex((c) => c.id === b.chapterId)
  const validChapterId = fromCurrent >= 0 ? b.chapterId : chapters[0]?.id ?? ''
  const furthestChapterIndex =
    typeof b.furthestChapterIndex === 'number' &&
    b.furthestChapterIndex >= 0 &&
    b.furthestChapterIndex < chapters.length
      ? b.furthestChapterIndex
      : Math.max(0, fromCurrent)
  return {
    ...b,
    chapterId: validChapterId,
    content: '',
    toc,
    readChapterIds,
    furthestChapterIndex: furthestChapterIndex < 0 ? 0 : furthestChapterIndex,
  }
}

/** 单巨章自动重分章的最小字数阈值（小书不折腾） */
const AUTO_CHAPTERIZE_MIN_CHARS = 30000

/**
 * 只有一章的大部头：用最新解析规则（含网文数字编号标题）重新切章，
 * 并把已保存的阅读进度重映射到新章节。无可切分时返回 null。
 */
function autoChapterizeIfNeeded(book: Book): Book | null {
  if (book.chapters.length !== 1 || book.chapterizeTried) return null
  const only = book.chapters[0]
  if (!only?.content || only.content.length < AUTO_CHAPTERIZE_MIN_CHARS) return null
  let chapters: Chapter[]
  try {
    chapters = parseChapters(only.content)
  } catch {
    return null
  }
  if (chapters.length < 3) {
    // 无法切分：打上标记，避免每次启动都对大文本重复全文解析（阻塞水合）
    return { ...book, chapterizeTried: true }
  }
  chapters = chapters.map((c, i) => ({ ...c, id: `ch-${i}` }))

  // 进度重映射：旧段落号 → 全局字符偏移（近似） → 所在新章节 → 章内段落号
  const oldParas = splitParagraphTexts(only.content)
  const oldIdx = Math.min(Math.max(0, book.paragraphIndex || 0), Math.max(0, oldParas.length - 1))
  let charsBefore = 0
  for (let i = 0; i < oldIdx; i++) charsBefore += oldParas[i].length + 1
  let target = chapters[0]
  for (const c of chapters) {
    if (c.startIndex <= charsBefore) target = c
    else break
  }
  const paras = splitParagraphTexts(target.content)
  const rel = Math.max(0, charsBefore - target.startIndex)
  let acc = 0
  let pIdx = 0
  for (let i = 0; i < paras.length; i++) {
    if (acc >= rel) {
      pIdx = i
      break
    }
    acc += paras[i].length + 1
    pIdx = i + 1
  }
  pIdx = Math.min(pIdx, Math.max(0, paras.length - 1))
  const targetIdx = chapters.findIndex((c) => c.id === target.id)

  return {
    ...book,
    chapters,
    toc: tocFromChapters(chapters),
    chapterId: target.id,
    paragraphIndex: pIdx,
    chapterizeTried: true,
    readChapterIds:
      (book.readChapterIds?.length ?? 0) > 0
        ? chapters.slice(0, targetIdx + 1).map((c) => c.id)
        : book.readChapterIds || [],
    furthestChapterIndex: targetIdx,
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
      books: [],
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
        if (chapters.length === 0 || chapters.every((c) => !c.content?.trim())) {
          throw new Error('内容为空，无法导入。请换一个文件试试。')
        }
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
        if (
          !parsed.chapters?.length ||
          parsed.chapters.every((c) => !c.content?.trim())
        ) {
          throw new Error('未能从 EPUB 中提取到正文，请换一个文件试试。')
        }
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
        const paras = splitParagraphTexts(chapter.content)
        const progressPercent = calcProgress(chapterIndex, book.chapters.length, paragraphIndex, paras.length)

        // 仅在真正读过（非仅跳转到章首）时记入已读
        const visited =
          paragraphIndex > 0 ||
          source === 'tts' ||
          note === '手动书签' ||
          note === '点击定位' ||
          note === '下翻定位'
        const readChapterIds = visited
          ? [...new Set([...(book.readChapterIds || []), chapterId])]
          : book.readChapterIds || []
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
        // 逐本 normalize，单本坏数据不影响其他书
        const rawBooks = (p.books ?? current.books) as Book[]
        const books: Book[] = []
        for (const b of rawBooks) {
          try {
            books.push(normalizeBook(b))
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('normalizeBook 失败，跳过该书籍', b?.id, b?.title, err)
          }
        }
        return {
          ...current,
          ...p,
          books,
          settings: { ...defaultSettings, ...(p.settings || current.settings) },
        }
      },
    },
  ),
)
