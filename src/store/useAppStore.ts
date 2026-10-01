import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { AudioChapter, Book, Chapter, ProgressSnapshot, ReaderSettings, Screen, TabId, TocEntry } from '../types'
import type { ParsedEbook } from '../utils/epubParser'
import { bindTocToChapters, tocFromChapters } from '../utils/epubParser'
import { COVER_COLORS, calcProgress, guessTitleFromContent, parseChapters, splitParagraphTexts } from '../utils/chapterParser'
import { createIdbStorage } from '../utils/idbStorage'
import { parseAudioPackage } from '../utils/audioPackage'
import { saveChapterAudio, saveBookSource, deleteBookAudio } from '../utils/audioPackageStore'

/** 导入音频包的返回结果 */
export interface AudioImportResult {
  bookId: string
  /** 本次新增/更新的音频章节数 */
  mergedCount: number
  /** 全书累计有音频的章节数 */
  totalCount: number
  /** 是否新建书籍 */
  isNew: boolean
}

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
  importAudioPackage: (file: File) => Promise<AudioImportResult>
  removeBook: (bookId: string) => void
  updateReadingProgress: (payload: {
    bookId: string
    chapterId: string
    paragraphIndex: number
    charOffset?: number
    /** 音频章节传渲染单元数（句+注释），纯文本章节缺省按段落数 */
    paragraphCount?: number
    source: 'read' | 'audio'
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
  playbackRate: 1,
  autoScroll: true,
  pagingMode: 'scroll',
  sleepMinutes: 0,
}

function normalizeBook(book: Book): Book {
  const b = autoChapterizeIfNeeded(book) ?? book
  const chapters = b.chapters || []
  let toc = b.toc
  if (chapters.length && chapters.every((c) => !c.href)) {
    toc = tocFromChapters(chapters)
  } else if (!toc?.length) {
    toc = tocFromChapters(chapters)
  } else if (chapters.length && toc.some((t) => !t.chapterId)) {
    toc = bindTocToChapters(
      toc.map((t) => ({ title: t.title, level: t.level ?? 0, href: t.href || '' })),
      chapters,
    )
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

/** 单巨章自动重分章的最小字数阈值 */
const AUTO_CHAPTERIZE_MIN_CHARS = 30000
/** 重分章算法版本 */
const CHAPTERIZE_TRY_VERSION = 4

function paraOffsetOf(content: string, paragraphIndex: number): number {
  const paras = splitParagraphTexts(content)
  const idx = Math.min(Math.max(0, paragraphIndex), Math.max(0, paras.length - 1))
  let off = 0
  for (let i = 0; i < idx; i++) off += paras[i].length + 1
  return off
}

/** 用最新解析规则自动重新切分单巨章书籍（TXT），无可切分时返回 null */
export function autoChapterizeIfNeeded(book: Book): Book | null {
  if ((book.chapterizeTryVersion ?? 0) >= CHAPTERIZE_TRY_VERSION) return null
  const old = book.chapters || []
  if (old.length === 0) return null
  if (old.some((c) => c.href)) return null

  let sourceText = ''
  let charsBefore = 0
  if (old.length === 1) {
    const only = old[0]
    if (!only?.content || only.content.length < AUTO_CHAPTERIZE_MIN_CHARS) return null
    sourceText = only.content
    charsBefore = paraOffsetOf(only.content, book.paragraphIndex || 0)
  } else {
    if ((book.chapterizeTryVersion ?? 0) >= 3) return null
    sourceText = old.map((c) => `${c.title}\n${c.content}`).join('\n')
    const idx = Math.max(0, old.findIndex((c) => c.id === book.chapterId))
    for (let i = 0; i < idx; i++) {
      charsBefore += old[i].title.length + 1 + (old[i].content?.length ?? 0) + 1
    }
    const cur = old[idx]
    if (cur) charsBefore += cur.title.length + 1 + paraOffsetOf(cur.content || '', book.paragraphIndex || 0)
  }

  let chapters: Chapter[]
  try {
    chapters = parseChapters(sourceText)
  } catch {
    return null
  }
  if (chapters.length < 3) {
    return { ...book, chapterizeTryVersion: CHAPTERIZE_TRY_VERSION }
  }
  chapters = chapters.map((c, i) => ({ ...c, id: `ch-${i}` }))

  let target = chapters[0]
  for (const c of chapters) {
    if (c.startIndex <= charsBefore) target = c
    else break
  }
  if (!target.content?.trim()) {
    const idx = chapters.findIndex((c) => c.id === target.id)
    const better =
      chapters.find((c, i) => i > idx && c.content?.trim()) ?? chapters.find((c) => c.content?.trim())
    if (better) target = better
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
    chapterizeTryVersion: CHAPTERIZE_TRY_VERSION,
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

  const tocRaw = parsed.toc?.length ? parsed.toc : null
  let toc: TocEntry[]
  if (!tocRaw || chapters.every((c) => !c.href)) {
    toc = tocFromChapters(chapters)
  } else {
    const bound = bindTocToChapters(tocRaw, chapters)
    toc = bound.every((t) => !t.chapterId) ? tocFromChapters(chapters) : bound
  }

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
    chapterizeTryVersion: CHAPTERIZE_TRY_VERSION,
  }
}

/** 由 manifest 章节构造纯文本（句拼正文 + 换行接注释），供目录/进度/纯文本兜底 */
function chapterContentFromAudio(ac: AudioChapter): string {
  const body = ac.sentences.map((s) => s.text).join('')
  const notes = ac.notes.map((n) => n.text).join('\n')
  return notes ? `${body}\n${notes}` : body
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
        if (!parsed.chapters?.length || parsed.chapters.every((c) => !c.content?.trim())) {
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

      importAudioPackage: async (file) => {
        const pkg = await parseAudioPackage(file)
        const { manifest } = pkg

        // 找到已有书籍（按 manifest.book.id 幂等合并），否则新建
        const existing = get().books.find((b) => b.id === manifest.book.id)

        // 逐章落盘 mp3（幂等：重复导入覆盖同名文件）
        for (const [chapterId, bytes] of pkg.audio.entries()) {
          await saveChapterAudio(manifest.book.id, chapterId, bytes)
        }
        // 源文件落盘（供日后纯文本重读）
        if (pkg.source) {
          await saveBookSource(manifest.book.id, pkg.source.ext, pkg.source.bytes)
        }

        const audioChapters: Record<string, AudioChapter> = existing?.audioChapters
          ? { ...existing.audioChapters }
          : {}
        for (const ac of manifest.chapters) {
          audioChapters[ac.id] = ac
        }

        if (existing) {
          // 合并：章节并集 + 音频覆盖
          const mergedChapters = [...existing.chapters]
          for (const ac of manifest.chapters) {
            const idx = mergedChapters.findIndex((c) => c.id === ac.id)
            const ch: Chapter = {
              id: ac.id,
              title: ac.title,
              startIndex: idx >= 0 ? mergedChapters[idx].startIndex : mergedChapters.length,
              content: chapterContentFromAudio(ac),
            }
            if (idx >= 0) mergedChapters[idx] = ch
            else mergedChapters.push(ch)
          }
          const next: Book = {
            ...existing,
            title: manifest.book.title,
            author: manifest.book.author ?? existing.author,
            chapters: mergedChapters,
            toc: tocFromChapters(mergedChapters),
            audioChapters,
            audioChapterCount: Object.keys(audioChapters).length,
          }
          set({ books: get().books.map((b) => (b.id === next.id ? next : b)) })
          return {
            bookId: next.id,
            mergedCount: manifest.chapters.length,
            totalCount: next.audioChapterCount ?? 0,
            isNew: false,
          }
        }

        // 新建：整本书从 manifest 构造（音频章节自带句级对齐文本）
        const chapters: Chapter[] = manifest.chapters.map((ac, i) => ({
          id: ac.id,
          title: ac.title,
          startIndex: i,
          content: chapterContentFromAudio(ac),
        }))
        const book: Book = {
          id: manifest.book.id,
          title: manifest.book.title,
          author: manifest.book.author ?? 'PC 合成',
          coverColor: COVER_COLORS[get().books.length % COVER_COLORS.length],
          coverEmoji: manifest.book.title.slice(0, 1) || '书',
          content: '',
          chapters,
          toc: tocFromChapters(chapters),
          addedAt: Date.now(),
          lastReadAt: Date.now(),
          chapterId: chapters[0]?.id ?? '',
          paragraphIndex: 0,
          charOffset: 0,
          progressPercent: 0,
          furthestChapterIndex: 0,
          readChapterIds: chapters[0] ? [chapters[0].id] : [],
          audioChapters,
          audioChapterCount: chapters.length,
        }
        set({ books: [book, ...get().books], showImportHint: false })
        return {
          bookId: book.id,
          mergedCount: chapters.length,
          totalCount: chapters.length,
          isNew: true,
        }
      },

      removeBook: (bookId) => {
        set({
          books: get().books.filter((b) => b.id !== bookId),
          snapshots: get().snapshots.filter((s) => s.bookId !== bookId),
          activeBookId: get().activeBookId === bookId ? null : get().activeBookId,
          screen: get().activeBookId === bookId ? 'home' : get().screen,
        })
        // 异步清理磁盘音频（不阻塞 UI）
        void deleteBookAudio(bookId)
      },

      updateReadingProgress: ({
        bookId,
        chapterId,
        paragraphIndex,
        charOffset = 0,
        paragraphCount,
        source,
        note,
        recordSnapshot = true,
      }) => {
        const book = get().books.find((b) => b.id === bookId)
        if (!book) return
        const chapterIndex = book.chapters.findIndex((c) => c.id === chapterId)
        const chapter = book.chapters[chapterIndex]
        if (!chapter) return
        const paraCount = paragraphCount ?? splitParagraphTexts(chapter.content).length
        const progressPercent = calcProgress(chapterIndex, book.chapters.length, paragraphIndex, paraCount)

        const visited =
          paragraphIndex > 0 ||
          source === 'audio' ||
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
        const rawBooks = (p.books ?? current.books) as Book[]
        const books: Book[] = []
        for (const b of rawBooks) {
          try {
            books.push(normalizeBook(b))
          } catch {
            /* 单本坏数据不影响其他书 */
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
