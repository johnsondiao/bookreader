import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { Book, Chapter, ProgressSnapshot, ReaderSettings, Screen, TabId, TocEntry } from '../types'
import type { ParsedEbook } from '../utils/epubParser'
import { bindTocToChapters, tocFromChapters } from '../utils/epubParser'
import { COVER_COLORS, calcProgress, guessTitleFromContent, parseChapters, splitParagraphTexts } from '../utils/chapterParser'
import { withCharStats, CHAR_STATS_VERSION } from '../utils/charStats'
import { createIdbStorage } from '../utils/idbStorage'
import { DEFAULT_VOICE_NOTE, DEFAULT_VOICE_ZH } from '../utils/ttsVoices'
import { DEFAULT_LOCAL_MODEL } from '../utils/localTts'
import { agentLog } from '../utils/agentLog'

interface AppState {
  books: Book[]
  snapshots: ProgressSnapshot[]
  settings: ReaderSettings
  tab: TabId
  screen: Screen
  activeBookId: string | null
  showImportHint: boolean
  /** 刚导入、待展示字数/费用统计的书；null=不展示（不持久化） */
  importStatsBookId: string | null

  setTab: (tab: TabId) => void
  setImportStatsBook: (bookId: string | null) => void
  openBook: (bookId: string) => void
  closeReader: () => void
  importTextBook: (content: string, filename?: string) => string
  importParsedBook: (parsed: ParsedEbook) => string
  removeBook: (bookId: string) => void
  /** 补齐字数统计（本功能上线前导入的旧书）：传 bookId 只补一本，不传则补全部；一次 set 只触发一次持久化 */
  ensureBookCharStats: (bookId?: string) => void
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
  pagingMode: 'scroll',
  ttsSleepMinutes: 0,
  ttsVoiceZh: DEFAULT_VOICE_ZH,
  ttsVoiceNote: DEFAULT_VOICE_NOTE,
  // 默认本地免费引擎；网页预览没有原生插件时 ReaderPage 会报错提示切回在线
  ttsEngine: 'local',
  localModelId: DEFAULT_LOCAL_MODEL,
  localSpeakerId: 0,
}

function normalizeBook(book: Book): Book {
  // 单巨章书籍自动重分章（旧导入的无目录网文也能生成目录）
  const b = autoChapterizeIfNeeded(book) ?? book
  const chapters = b.chapters || []
  let toc = b.toc
  // TXT 书章节无 href，bind 流程永远匹配不上，直接按章节生成目录，
  // 避免持久化的坏 toc（无 chapterId → 目录整排"无正文"）残留
  if (chapters.length && chapters.every((c) => !c.href)) {
    toc = tocFromChapters(chapters)
  } else if (!toc?.length) {
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
/** 重分章算法版本：改进解析规则后 bump，让之前失败/旧版切分的书重新尝试 */
const CHAPTERIZE_TRY_VERSION = 4

/** 段落号 → 章内字符偏移（近似：每段按 length+1 计） */
function paraOffsetOf(content: string, paragraphIndex: number): number {
  const paras = splitParagraphTexts(content)
  const idx = Math.min(Math.max(0, paragraphIndex), Math.max(0, paras.length - 1))
  let off = 0
  for (let i = 0; i < idx; i++) off += paras[i].length + 1
  return off
}

/**
 * 用最新解析规则自动重新切章，并把已保存的阅读进度重映射到新章节。无可切分时返回 null。
 * 两种场景：
 *  1. 单巨章书（>3万字）：直接切分；
 *  2. 旧算法（v3 之前）已切过的书：把标题行放回还原文本后重切，
 *     淘汰旧版产生的垃圾章（空章/重复标题章）。
 */
export function autoChapterizeIfNeeded(book: Book): Book | null {
  if ((book.chapterizeTryVersion ?? 0) >= CHAPTERIZE_TRY_VERSION) return null
  const old = book.chapters || []
  if (old.length === 0) return null
  // EPUB 等带 href 的书不碰
  if (old.some((c) => c.href)) return null

  let sourceText = ''
  let charsBefore = 0
  if (old.length === 1) {
    const only = old[0]
    if (!only?.content || only.content.length < AUTO_CHAPTERIZE_MIN_CHARS) return null
    sourceText = only.content
    charsBefore = paraOffsetOf(only.content, book.paragraphIndex || 0)
  } else {
    // 只升级 v3 之前切出来的旧结果；v3+ 新切的已是最新规则
    if ((book.chapterizeTryVersion ?? 0) >= 3) return null
    // 还原文本：标题行 + 正文（空章的正文就是标题行，还原为重复标题行，
    // 重解析时会被空章过滤规则淘汰）
    sourceText = old.map((c) => `${c.title}\n${c.content}`).join('\n')
    const idx = Math.max(0, old.findIndex((c) => c.id === book.chapterId))
    for (let i = 0; i < idx; i++) {
      charsBefore += old[i].title.length + 1 + (old[i].content?.length ?? 0) + 1
    }
    const cur = old[idx]
    if (cur) {
      charsBefore += cur.title.length + 1 + paraOffsetOf(cur.content || '', book.paragraphIndex || 0)
    }
  }

  let chapters: Chapter[]
  try {
    chapters = parseChapters(sourceText)
  } catch {
    return null
  }
  if (chapters.length < 3) {
    // 无法切分：打上版本标记，避免每次启动都对大文本重复全文解析（阻塞水合）
    return { ...book, chapterizeTryVersion: CHAPTERIZE_TRY_VERSION }
  }
  agentLog(
    'useAppStore:autoChapterize',
    're-chapterized',
    { bookId: book.id, title: book.title, chapters: chapters.length, from: old.length },
    'A',
  )
  chapters = chapters.map((c, i) => ({ ...c, id: `ch-${i}` }))
  // 重分章后章节全变了，字数统计必须跟着重算，否则 totalChars 是旧值
  const stats = withCharStats(chapters)
  chapters = stats.chapters

  // 进度重映射：旧位置的全局字符偏移 → 所在新章节 → 章内段落号
  let target = chapters[0]
  for (const c of chapters) {
    if (c.startIndex <= charsBefore) target = c
    else break
  }
  // 落在空章时向后找最近的非空章（防御性兜底）
  if (!target.content?.trim()) {
    const idx = chapters.findIndex((c) => c.id === target.id)
    const better =
      chapters.find((c, i) => i > idx && c.content?.trim()) ??
      chapters.find((c) => c.content?.trim())
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
    totalChars: stats.totalChars,
    totalBillable: stats.totalBillable,
    charStatsVersion: CHAR_STATS_VERSION,
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
  // 导入时就统计各章计费字数与全书总字数，书架/目录/导入弹窗直接展示预估费用
  const charStats = withCharStats(chapters)

  const tocRaw = parsed.toc?.length ? parsed.toc : null
  // 目录生成跟 normalizeBook 用同一套规则：TXT 章节没 href，bindTocToChapters 永远匹配不上，
  // 会产出一整排 chapterId=null 的坏目录（刚导入时目录全部「无正文」且无法跳转，要等下次启动才被修好）
  let toc: TocEntry[]
  if (!tocRaw || chapters.every((c) => !c.href)) {
    toc = tocFromChapters(chapters)
  } else {
    const bound = bindTocToChapters(tocRaw, chapters)
    // 仍全部无法匹配则退回章节目录
    toc = bound.every((t) => !t.chapterId) ? tocFromChapters(chapters) : bound
  }

  return {
    id: uuid(),
    title: parsed.title,
    author: parsed.author,
    coverColor: parsed.coverColor,
    coverEmoji: parsed.title.slice(0, 1) || '书',
    content: '',
    chapters: charStats.chapters,
    toc,
    addedAt: Date.now(),
    lastReadAt: Date.now(),
    chapterId: chapters[0]?.id ?? '',
    paragraphIndex: 0,
    charOffset: 0,
    progressPercent: 0,
    furthestChapterIndex: 0,
    readChapterIds: chapters[0] ? [chapters[0].id] : [],
    totalChars: charStats.totalChars,
    totalBillable: charStats.totalBillable,
    charStatsVersion: CHAR_STATS_VERSION,
    // 章节已经是当前 parseChapters 规则切出来的，打上版本标记：
    // 否则下次启动 autoChapterizeIfNeeded 会把新书全文重切一遍（白耗水合时间，
    // 且「标题行+正文」还原重建会给序章多算进标题的字符，字数会漂移）
    chapterizeTryVersion: CHAPTERIZE_TRY_VERSION,
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
      importStatsBookId: null,

      setTab: (tab) => set({ tab }),

      setImportStatsBook: (bookId) => set({ importStatsBookId: bookId }),

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
        set({ books: [book, ...get().books], showImportHint: false, importStatsBookId: book.id })
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
        set({ books: [book, ...get().books], showImportHint: false, importStatsBookId: book.id })
        return book.id
      },

      removeBook: (bookId) => {
        set({
          books: get().books.filter((b) => b.id !== bookId),
          snapshots: get().snapshots.filter((s) => s.bookId !== bookId),
          activeBookId: get().activeBookId === bookId ? null : get().activeBookId,
          screen: get().activeBookId === bookId ? 'home' : get().screen,
          importStatsBookId: get().importStatsBookId === bookId ? null : get().importStatsBookId,
        })
      },

      ensureBookCharStats: (bookId) => {
        let filled = 0
        let totalBillable = 0
        const next = get().books.map((b) => {
          if (bookId && b.id !== bookId) return b
          // 口径版本对得上的书跳过：全书重扫是 O(总字数)，不能每次进书架都跑
          if (b.charStatsVersion === CHAR_STATS_VERSION) return b
          const r = withCharStats(b.chapters || [])
          filled++
          totalBillable += r.totalBillable
          return {
            ...b,
            chapters: r.chapters,
            totalChars: r.totalChars,
            totalBillable: r.totalBillable,
            charStatsVersion: CHAR_STATS_VERSION,
          }
        })
        if (filled === 0) return
        agentLog(
          'useAppStore:ensureBookCharStats',
          'backfill',
          { bookId, filled, totalBillable, version: CHAR_STATS_VERSION },
          'A',
        )
        set({ books: next })
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
