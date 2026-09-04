import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TocPanel } from '../components/TocPanel'
import { UnlockModal } from '../components/UnlockModal'
import { DebugPanel } from '../components/DebugPanel'
import { ReaderSettingsPanel } from '../components/ReaderSettingsPanel'
import { useAppStore } from '../store/useAppStore'
import { splitParagraphs, splitSentences } from '../utils/chapterParser'
import {
  BudgetExceeded,
  chapterCacheKey,
  classifyTtsError,
  createTtsController,
  DEFAULT_VOICE_NOTE,
  DEFAULT_VOICE_ZH,
  VOICE_CATALOG,
} from '../utils/tts'
import { migrateVoiceKey, getVoice } from '../utils/ttsVoices'
import { getClip, hashText } from '../utils/audioCache'
import { hasTtsKey, unlockTtsKey, TtsKeyLockedError } from '../utils/ttsKeyStore'
import {
  agentLog,
  getLastDebugHint,
  subscribeDebugLog,
  type DebugPayload,
} from '../utils/agentLog'
import { getTodayCostYuan, formatCost } from '../utils/costTracker'
import { costOfBillable, formatCharCount, formatCostEstimate } from '../utils/charStats'
import { isLocalTtsAvailable } from '../utils/localTts'
import { isAllFilesAccessGranted } from '../utils/audioFileStore'

type Panel = null | 'toc' | 'settings'

const INITIAL_VISIBLE = 40
const LOAD_MORE = 40
const TINY_CHAPTER = 40

/** 从 afterIndex 之后找下一章有可朗读段落的章节 */
function findNextSpeakableChapterId(
  chapters: { id: string; content: string }[],
  afterIndex: number,
): string | null {
  if (afterIndex < 0) return null
  for (let i = afterIndex + 1; i < chapters.length; i++) {
    const arr = splitParagraphs(chapters[i].content || '')
    if (arr.length > 0) return chapters[i].id
  }
  return null
}

/** 睡眠定时剩余秒数 → mm:ss / h:mm:ss */
function fmtSleepRemain(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function pickStartChapter(book: {
  chapterId: string
  paragraphIndex: number
  chapters: { id: string; content: string }[]
}) {
  let cid = book.chapterId || book.chapters[0]?.id || ''
  let pIndex = book.paragraphIndex || 0
  const current = book.chapters.find((c) => c.id === cid) ?? book.chapters[0]
  // 当前章无正文（或短扉页且未读进）时，跳到第一个有内容的章，避免开书即见"本章暂无正文"
  const needSkip =
    !current?.content?.trim() ||
    ((current.content?.length || 0) < TINY_CHAPTER && pIndex === 0)
  if (needSkip) {
    const better = book.chapters.find((c) => (c.content?.length || 0) >= TINY_CHAPTER)
    if (better && better.id !== cid) {
      cid = better.id
      pIndex = 0
    }
  }
  return { cid, pIndex }
}

export function ReaderPage() {
  const activeBookId = useAppStore((s) => s.activeBookId)
  const books = useAppStore((s) => s.books)
  const book = useMemo(() => books.find((b) => b.id === activeBookId), [books, activeBookId])
  const settings = useAppStore((s) => s.settings)
  const closeReader = useAppStore((s) => s.closeReader)
  const updateReadingProgress = useAppStore((s) => s.updateReadingProgress)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const [menuOpen, setMenuOpen] = useState(true)
  const [panel, setPanel] = useState<Panel>(null)
  const [paraIndex, setParaIndex] = useState(0)
  const [activeSentence, setActiveSentence] = useState(-1)
  const [chapterId, setChapterId] = useState('')
  const [ttsOn, setTtsOn] = useState(false)
  const [ttsPaused, setTtsPaused] = useState(false)
  const [toast, setToast] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)
  const [engineStatus, setEngineStatus] = useState(
    '在线语音 · MiniMax speech-2.8-turbo（¥2/万字，首次合成需联网，之后缓存）',
  )
  const [todayCost, setTodayCost] = useState<string>('不到1分')
  const [debugLines, setDebugLines] = useState<DebugPayload[]>([])
  const [debugOpen, setDebugOpen] = useState<boolean>(() => {
    // 读 Zustand settings.ttsDebugPanel，SSR/未初始化时值为 false（默认不展开）
    try {
      // 初始化时 useAppStore.getState 比订阅更早，避免 hydration 前 undefined
      return !!useAppStore.getState().settings.ttsDebugPanel
    } catch {
      return false
    }
  })
  /** 调试面板开关变化时同步写入 settings，下次启动保持 */
  const setDebugOpenPersistent = useCallback(
    (v: boolean | ((p: boolean) => boolean)) => {
      const next = typeof v === 'function' ? (v as (p: boolean) => boolean)(debugOpen) : v
      setDebugOpen(next)
      try {
        useAppStore.getState().updateSettings({ ttsDebugPanel: next })
      } catch {
        /* ignore */
      }
    },
    [debugOpen],
  )
  /** 语音解锁弹窗：首次朗读时要求输入密码，解密 MiniMax key */
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [unlockError, setUnlockError] = useState('')
  const [unlockLoading, setUnlockLoading] = useState(false)
  const unlockResolverRef = useRef<((ok: boolean) => void) | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const paraRefs = useRef<(HTMLParagraphElement | null)[]>([])
  /** 打开书籍时待定位到的记忆段落（渲染就绪后滚动过去） */
  const pendingScrollRef = useRef<number | null>(null)
  /** 滚动保存进度的节流时间戳 */
  const lastScrollSaveRef = useRef(0)
  /** 睡眠定时：到点自动停止朗读 */
  const [sleepRemainSec, setSleepRemainSec] = useState<number | null>(null)
  const sleepDeadlineRef = useRef<number | null>(null)
  const sleepIntervalRef = useRef<number | null>(null)
  /** 翻页动画进行中，防止连续触发 */
  const flippingRef = useRef(false)
  /** 手动合成中（只合成不播放） */
  const [synthing, setSynthing] = useState(false)
  const [synthMsg, setSynthMsg] = useState('')
  const ttsRef = useRef(createTtsController())
  const speakingRef = useRef(false)
  const pendingAutoSpeakRef = useRef(false)
  /** 连章续读：跳过「正在准备」toast */
  const continueQuietRef = useRef(false)
  const touchRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const chapterIdRef = useRef(chapterId)
  const speakFromRef = useRef<(start: number) => Promise<void>>(async () => {})
  const bookRef = useRef(book)
  bookRef.current = book
  const mountedRef = useRef(true)
  const toastTimerRef = useRef<number | null>(null)
  // saveProgress 定义在下方（useCallback），这里先占位，后续赋值。用 ref 引用避免 useCallback 定义前使用。
  const saveProgressRef = useRef<
    (
      ...args: [
        chapterId: string,
        paragraphIndex: number,
        source?: string,
        note?: string,
        recordSnapshot?: boolean,
        charOffset?: number,
      ]
    ) => void
  >(() => {})

  const currentChapterIndex = useMemo(() => {
    return book ? book.chapters.findIndex((c) => c.id === chapterId) : -1
  }, [book, chapterId])

  const chapter = useMemo(
    () => book?.chapters.find((c) => c.id === chapterId) ?? book?.chapters[0],
    [book, chapterId],
  )

  const paragraphs = useMemo(
    () => (chapter ? splitParagraphs(chapter.content || '') : []),
    [chapter],
  )

  /** 本章字数与预估合成费用（金额按计费字符算：汉字×2）；旧数据未统计时为 null，不显示 */
  const chapterCostLabel = useMemo(() => {
    const chars = chapter?.charCount
    const billable = chapter?.billableChars
    if (typeof chars !== 'number' || typeof billable !== 'number') return null
    return `${formatCharCount(chars)} · 约 ${formatCostEstimate(costOfBillable(billable))}`
  }, [chapter?.charCount, chapter?.billableChars])

  const visibleParagraphs = useMemo(
    () => paragraphs.slice(0, Math.min(visibleCount, paragraphs.length)),
    [paragraphs, visibleCount],
  )

  /** 每段的句子列表（与 TTS planSegments 一一对应） */
  const paraSentences = useMemo(
    () => paragraphs.map((p) => splitSentences(p.text)),
    [paragraphs],
  )
  /** 每段首句的全局索引（用于 paraIndex+sentIdx → globalIdx 映射） */
  const paraSentStart = useMemo(() => {
    const starts: number[] = []
    let acc = 0
    for (const sents of paraSentences) {
      starts.push(acc)
      acc += sents.length
    }
    return starts
  }, [paraSentences])
  /** 全局句子总数 */
  const totalSentences = paraSentStart.length > 0 ? paraSentStart[paraSentStart.length - 1] + paraSentences[paraSentences.length - 1].length : 0
  /** 全局句子索引 → 段落索引 映射（供 TTS onSentence 回调使用） */
  const sentToParaRef = useRef<number[]>([])
  sentToParaRef.current = useMemo(() => {
    const map: number[] = []
    paraSentences.forEach((sents, pi) => {
      for (let si = 0; si < sents.length; si++) map.push(pi)
    })
    return map
  }, [paraSentences])

  /** 已合成句子的全局索引集合（正文下划线标记） */
  const [synthedSentences, setSynthedSentences] = useState<Set<number>>(() => new Set())
  /** 缓存写入后 bump，触发下划线标记刷新 */
  const [marksVersion, setMarksVersion] = useState(0)

  /**
   * 从音频缓存读出当前章+当前音色已合成的句子区间，映射为全局句子索引。
   * 区间计算与 tts.ts 完全一致（段落 \n 拼接 + splitSentences）。
   */
  const refreshSynthMarks = useCallback(async () => {
    if (!book || !chapter) {
      setSynthedSentences(new Set())
      return
    }
    try {
      const zhKey = migrateVoiceKey(settings.ttsVoiceZh) || DEFAULT_VOICE_ZH
      const noteKey = migrateVoiceKey(settings.ttsVoiceNote) || DEFAULT_VOICE_NOTE
      const textVoice = getVoice(zhKey) || VOICE_CATALOG[0]
      const noteVoice = getVoice(noteKey) || textVoice
      const clip = await getClip(chapterCacheKey(book.id, chapter.id, textVoice.key, noteVoice.key))
      if (!clip?.chunks?.length) {
        setSynthedSentences(new Set())
        return
      }
      // textHash 校验：正文变了则标记全部作废（与 tts.ts 缓存命中规则一致）
      let fullText = ''
      for (const p of paragraphs) {
        fullText += p.text
        fullText += '\n'
      }
      if (clip.textHash !== hashText(fullText)) {
        setSynthedSentences(new Set())
        return
      }
      const chunks = clip.chunks.filter((c) => c.blob.size > 0)
      const set = new Set<number>()
      let offset = 0
      let gi = 0
      for (const p of paragraphs) {
        let so = offset
        for (const s of splitSentences(p.text)) {
          const se = so + s.length
          // 任一缓存块覆盖该句即视为已合成
          if (chunks.some((c) => c.charStart <= so && c.charEnd >= se)) set.add(gi)
          so = se
          gi++
        }
        offset += p.text.length + 1
      }
      setSynthedSentences(set)
    } catch {
      /* 缓存读取失败：不显示下划线，不影响阅读 */
      setSynthedSentences(new Set())
    }
    // 依赖用 id 而非对象：进度保存会频繁替换 book 对象，用对象会触发过度刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id, chapter?.id, paragraphs, settings.ttsVoiceZh, settings.ttsVoiceNote])

  useEffect(() => {
    void refreshSynthMarks()
  }, [refreshSynthMarks, marksVersion])

  useEffect(() => {
    chapterIdRef.current = chapterId
  }, [chapterId])

  useEffect(() => {
    if (!book) return
    const { cid, pIndex } = pickStartChapter(book)
    setChapterId(cid)
    setParaIndex(pIndex)
    setVisibleCount(INITIAL_VISIBLE)
    setMenuOpen(true)
    // 恢复阅读位置：记住目标段落，等它被渲染后滚动过去（见下方定位 effect）
    pendingScrollRef.current = pIndex > 0 ? pIndex : null
    if (cid !== book.chapterId) {
      updateReadingProgress({
        bookId: book.id,
        chapterId: cid,
        paragraphIndex: 0,
        source: 'read',
        note: '跳过短扉页',
        recordSnapshot: false,
      })
    }
  }, [book?.id])

  useEffect(() => {
    // 恢复定位场景由专门 effect 处理，不能重置到顶部
    if (pendingScrollRef.current != null) return
    setVisibleCount(INITIAL_VISIBLE)
    contentRef.current?.scrollTo({ top: 0 })
  }, [chapter?.id])

  // 恢复定位：目标段落进入渲染范围后，立即（非动画）滚动过去
  useEffect(() => {
    const target = pendingScrollRef.current
    if (target == null) return
    const el = paraRefs.current[target]
    if (!el) return
    pendingScrollRef.current = null
    el.scrollIntoView({ block: 'center' })
  }, [visibleCount, chapterId, paragraphs.length])

  useEffect(() => {
    if (paraIndex + 5 >= visibleCount && visibleCount < paragraphs.length) {
      setVisibleCount((v) => Math.min(paragraphs.length, Math.max(v, paraIndex + INITIAL_VISIBLE)))
    }
  }, [paraIndex, visibleCount, paragraphs.length])

  useEffect(() => {
    return () => {
      ttsRef.current.stop()
      mountedRef.current = false
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current)
        toastTimerRef.current = null
      }
      if (sleepIntervalRef.current !== null) {
        window.clearInterval(sleepIntervalRef.current)
        sleepIntervalRef.current = null
      }
    }
  }, [])

  const showToast = (msg: string, ms = 2800) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    setToast(msg)
    toastTimerRef.current = window.setTimeout(() => {
      setToast('')
      toastTimerRef.current = null
    }, ms)
  }

  /**
   * 弹出语音解锁框，返回是否解锁成功。
   * speakFrom 调用：未解锁时 await，用户输对密码后自动继续朗读。
   */
  const requestUnlock = useCallback((): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setUnlockError('')
      unlockResolverRef.current = resolve
      setUnlockOpen(true)
    })
  }, [])

  /** 解锁弹窗提交进行中：阻止「取消」在 unlockTtsKey resolve 之前生效 */
  const unlockSubmittingRef = useRef(false)

  /** 弹窗内：提交密码尝试解锁 */
  const onSubmitUnlock = useCallback(
    async (password: string) => {
      if (unlockSubmittingRef.current) return
      unlockSubmittingRef.current = true
      setUnlockLoading(true)
      setUnlockError('')
      let ok = false
      try {
        ok = await unlockTtsKey(password)
      } catch {
        ok = false
      } finally {
        unlockSubmittingRef.current = false
        setUnlockLoading(false)
      }
      if (!mountedRef.current) return
      if (ok) {
        setUnlockOpen(false)
        const resolver = unlockResolverRef.current
        unlockResolverRef.current = null
        resolver?.(true)
      } else {
        setUnlockError('密码错误，请重试')
      }
    },
    [],
  )

  /** 弹窗内：取消 */
  const onCancelUnlock = useCallback(() => {
    if (unlockSubmittingRef.current) return
    setUnlockOpen(false)
    const resolver = unlockResolverRef.current
    unlockResolverRef.current = null
    resolver?.(false)
  }, [])

  // #region agent log
  useEffect(() => subscribeDebugLog(setDebugLines), [])
  // #endregion

  // 挂载后刷新今日花费（接口是异步的），并每 30s 轮询一次
  useEffect(() => {
    let cancelled = false
    async function refresh() {
      const v = await getTodayCostYuan()
      if (!cancelled) setTodayCost(formatCost(v))
    }
    void refresh()
    const t = setInterval(() => void refresh(), 30000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // onSynthProgress 中也会异步更新今日花费，避免同步路径 Promise<number> 赋值
  const updateTodayCost = () => {
    void (async () => {
      const v = await getTodayCostYuan()
      if (mountedRef.current) setTodayCost(formatCost(v))
    })()
  }

  // 旧版本残留的本地音色 key（华严 / sherpa / 早期英文音色）迁移到默认在线音色
  useEffect(() => {
    const next = {
      ttsVoiceZh: migrateVoiceKey(settings.ttsVoiceZh) || DEFAULT_VOICE_ZH,
      ttsVoiceNote: migrateVoiceKey(settings.ttsVoiceNote) || DEFAULT_VOICE_ZH,
    }
    if (
      next.ttsVoiceZh !== settings.ttsVoiceZh ||
      next.ttsVoiceNote !== settings.ttsVoiceNote
    ) {
      updateSettings(next)
    }
    setEngineStatus('在线语音 · MiniMax speech-2.8-turbo（¥2/万字，首次合成需联网，之后缓存）')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id])

  const saveProgress = useCallback(
    (cid: string, pIndex: number, source: 'read' | 'tts', note?: string, recordSnapshot = true) => {
      if (!book) return
      updateReadingProgress({
        bookId: book.id,
        chapterId: cid,
        paragraphIndex: pIndex,
        source,
        note,
        recordSnapshot,
      })
    },
    [book, updateReadingProgress],
  )
  // saveProgress 定义后同步写入 saveProgressRef，保证上方使用该 ref 的回调永远是最新 saveProgress
  saveProgressRef.current = saveProgress as typeof saveProgressRef.current

  const scrollToPara = (index: number) => {
    const el = paraRefs.current[index]
    if (el && settings.autoScroll) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  const loadMore = useCallback(() => {
    setVisibleCount((v) => {
      if (v >= paragraphs.length) return v
      return Math.min(paragraphs.length, v + LOAD_MORE)
    })
  }, [paragraphs.length])

  const onScrollContent = () => {
    const el = contentRef.current
    if (!el) return
    const remain = el.scrollHeight - el.scrollTop - el.clientHeight
    if (remain < 400) loadMore()
    // 朗读中位置由 TTS 主导：自动平滑滚动的中间态会把进度往回写，短路掉
    if (speakingRef.current) return
    // 滚动阅读时记住位置（节流 800ms，不写快照避免刷屏）：
    // 找到当前视口顶部附近的段落，与正在朗读的段落一致时不重复写入
    const now = Date.now()
    if (now - lastScrollSaveRef.current < 800) return
    if (!chapter) return
    const boxTop = el.getBoundingClientRect().top
    let idx = -1
    const refs = paraRefs.current
    for (let i = 0; i < refs.length; i++) {
      const p = refs[i]
      if (!p) break
      if (p.getBoundingClientRect().top - boxTop <= 140) idx = i
      else break
    }
    if (idx < 0 || idx === paraIndex) return
    lastScrollSaveRef.current = now
    setParaIndex(idx)
    saveProgress(chapter.id, idx, 'read', '滚动定位', false)
  }

  const stopTts = useCallback(() => {
    speakingRef.current = false
    pendingAutoSpeakRef.current = false
    continueQuietRef.current = false
    try {
      ttsRef.current.stop()
    } catch {
      /* ignore */
    }
    setTtsOn(false)
    setTtsPaused(false)
    setActiveSentence(-1)
  }, [])

  /** 清除睡眠定时 */
  const clearSleepTimer = useCallback(() => {
    if (sleepIntervalRef.current !== null) {
      window.clearInterval(sleepIntervalRef.current)
      sleepIntervalRef.current = null
    }
    sleepDeadlineRef.current = null
    setSleepRemainSec(null)
  }, [])

  /** 启动睡眠定时：倒计时归零时若正在朗读则自动停止 */
  const startSleepTimer = useCallback(
    (minutes: number) => {
      if (sleepIntervalRef.current !== null) {
        window.clearInterval(sleepIntervalRef.current)
      }
      sleepDeadlineRef.current = Date.now() + minutes * 60 * 1000
      setSleepRemainSec(Math.round(minutes * 60))
      sleepIntervalRef.current = window.setInterval(() => {
        const deadline = sleepDeadlineRef.current
        if (deadline == null || sleepIntervalRef.current == null) return
        const remain = Math.round((deadline - Date.now()) / 1000)
        if (remain > 0) {
          setSleepRemainSec(remain)
          return
        }
        // 到点：清理定时器；正在朗读才停，未在朗读则静默结束（避免下次开播被立即打断）
        window.clearInterval(sleepIntervalRef.current)
        sleepIntervalRef.current = null
        sleepDeadlineRef.current = null
        setSleepRemainSec(null)
        if (speakingRef.current) {
          stopTts()
          showToast('定时时间到，已停止朗读')
        }
      }, 1000)
    },
    [stopTts],
  )

  /** 睡眠定时设置：输入分钟数，0=关闭；记住上次时长 */
  const promptSleepTimer = () => {
    const activeMin = sleepDeadlineRef.current
      ? Math.max(1, Math.round((sleepDeadlineRef.current - Date.now()) / 60000))
      : settings.ttsSleepMinutes || 0
    const input = window.prompt(
      '睡眠定时（分钟）\n时间到自动停止朗读，输入 0 关闭。\n常用：15 / 30 / 60 / 90',
      activeMin ? String(activeMin) : '',
    )
    if (input == null) return
    const trimmed = input.trim()
    if (trimmed === '') return
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) {
      alert('请输入 0 或正数。')
      return
    }
    const minutes = Math.round(n)
    updateSettings({ ttsSleepMinutes: minutes })
    if (minutes === 0) {
      clearSleepTimer()
      showToast('已关闭睡眠定时')
    } else {
      startSleepTimer(minutes)
      showToast(`${minutes} 分钟后自动停止朗读`)
    }
  }

  /**
   * 手动合成开关：点一下开始合成当前章（只合成不播放，从当前位置向后到章尾再回头），
   * 再点一下停止。已合成的段存缓存+文件，之后朗读不重复扣费。
   */
  const toggleSynth = async () => {
    if (synthing) {
      ttsRef.current.stop()
      setSynthing(false)
      setSynthMsg('')
      showToast('已停止合成，已完成部分已保存')
      return
    }
    if (ttsOn) {
      showToast('正在朗读中，后台已在自动合成')
      return
    }
    if (!book || !chapter) return
    // 网页预览没有原生插件，本地引擎不可用时自动回退在线
    const engine: 'local' | 'online' =
      isLocalTtsAvailable() && settings.ttsEngine !== 'online' ? 'local' : 'online'
    // 本地引擎不需要 MiniMax key，不弹解锁框
    if (engine === 'online' && !(await hasTtsKey())) {
      if (!mountedRef.current) return
      const ok = await requestUnlock()
      if (!mountedRef.current || !ok) return
    }
    setSynthing(true)
    setMenuOpen(true)
    const zhKey = migrateVoiceKey(settings.ttsVoiceZh) || DEFAULT_VOICE_ZH
    const noteKey = migrateVoiceKey(settings.ttsVoiceNote) || DEFAULT_VOICE_NOTE
    const startSent = paraSentStart[paraIndex] ?? 0
    agentLog('ReaderPage:toggleSynth', 'start', { chapterId: chapter.id, startSent, zhKey, noteKey, engine: settings.ttsEngine }, 'A')
    try {
      await ttsRef.current.synthChapter({
        bookId: book.id,
        bookTitle: book.title,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        paragraphs,
        startSentenceIndex: startSent,
        voiceKey: zhKey,
        noteVoiceKey: noteKey,
        budgetYuan: settings.dailyBudgetYuan,
        engine,
        localModelId: settings.localModelId,
        localSpeakerId: settings.localSpeakerId,
        onSynthProgress: (p: { progress: number; message: string; stage: string }) => {
          updateTodayCost()
          setSynthMsg(`${p.message || '合成中'} ${Math.round((p.progress || 0) * 100)}%`)
        },
        onStatus: (_s: string, msg?: string) => {
          if (msg) setSynthMsg(msg)
        },
        onFileSaved: (r: { fileOk: boolean; idbOk: boolean; error?: string }) => {
          // 缓存已写入：刷新正文的已合成下划线标记
          setMarksVersion((v) => v + 1)
          if (r.fileOk) return
          agentLog('ReaderPage:toggleSynth', 'audio file save failed', { err: r.error }, 'E')
          showToast(`⚠️ 音频文件保存失败：${r.error ?? '未知原因'}（已存入应用内缓存）`, 10000)
        },
      })
      if (mountedRef.current) showToast('本章合成完成，朗读时不再扣费')
    } catch (err) {
      if (!mountedRef.current) return
      if (err instanceof Error && (err.name === 'SpeakAborted' || err.message === 'aborted')) {
        // 用户主动停止或被新任务中断：静默
      } else if (err instanceof BudgetExceeded) {
        showToast(`⚠️ ${err.message}`, 10000)
      } else {
        const c = classifyTtsError(err)
        agentLog('ReaderPage:toggleSynth', 'synth failed', { err: err instanceof Error ? err.message : String(err) }, 'C')
        showToast(`${c.title}${c.advice ? '\n' + c.advice : ''}`, 10000)
      }
    } finally {
      if (mountedRef.current) {
        setSynthing(false)
        setSynthMsg('')
        updateTodayCost()
      }
    }
  }

  const jumpChapter = useCallback(
    (cid: string) => {
      // #region agent log
      agentLog('ReaderPage:jumpChapter', 'jump', { cid, wasSpeaking: speakingRef.current }, 'D')
      // #endregion
      pendingAutoSpeakRef.current = false
      continueQuietRef.current = false
      // 主动跳转不继承开书时的恢复定位目标，避免卡住的 pendingScroll 干扰滚动位置
      pendingScrollRef.current = null
      try {
        stopTts()
      } catch {
        /* ignore */
      }
      setChapterId(cid)
      setParaIndex(0)
      setActiveSentence(-1)
      setPanel(null)
      saveProgress(cid, 0, 'read', '切换章节')
    },
    [saveProgress, stopTts],
  )

  const goRelativeChapter = useCallback(
    (delta: number) => {
      if (!book) return
      const idx = book.chapters.findIndex((c) => c.id === chapterIdRef.current)
      const next = book.chapters[idx + delta]
      if (!next) {
        showToast(delta < 0 ? '已是第一章' : '已是最后一章')
        return
      }
      jumpChapter(next.id)
      showToast(next.title)
    },
    [book, jumpChapter],
  )

  const speakFrom = useCallback(
    async (startSent: number) => {
      if (!book || !chapter) return

      // 首次朗读需解锁语音（输入密码解密 MiniMax key）；本地引擎不需要
      const engine: 'local' | 'online' =
        isLocalTtsAvailable() && settings.ttsEngine !== 'online' ? 'local' : 'online'
      if (engine === 'online' && !(await hasTtsKey())) {
        if (!mountedRef.current) return
        const ok = await requestUnlock()
        if (!mountedRef.current) return
        if (!ok) return // 用户取消
      }

      const quiet = continueQuietRef.current
      continueQuietRef.current = false
      speakingRef.current = true
      if (!mountedRef.current) return
      setTtsOn(true)
      setTtsPaused(false)
      setMenuOpen(true)

      const zhKey = migrateVoiceKey(settings.ttsVoiceZh) || DEFAULT_VOICE_ZH
      const noteKey = migrateVoiceKey(settings.ttsVoiceNote) || DEFAULT_VOICE_NOTE
      // #region agent log
      agentLog('ReaderPage:speakFrom', 'start', { zhKey, noteKey, startSent, quiet, chapterId: chapter.id }, 'D')
      // #endregion

      if (!quiet) showToast('正在准备语音…', 4000)

      // 记录最后一句开始的句子索引：失败重试时从失败的句子继续，而不是每次都回到首句
      let lastSent = -1

      // 共享回调：避免主流程和重试流程重复定义
      const callbacks = {
        onParagraph: (i: number) => {
          if (!speakingRef.current) return
          setParaIndex(i)
          scrollToPara(i)
        },
        onSentence: (si: number) => {
          lastSent = si
          if (!speakingRef.current) return
          setActiveSentence(si)
          const pi = sentToParaRef.current[si] ?? 0
          setParaIndex(pi)
          scrollToPara(pi)
          // 每句只更新进度不写 snapshot，避免 500 条快照被 TTS 噪声填满
          saveProgress(chapter.id, pi, 'tts', '朗读进度', false)
        },
        onStatus: (s: string, msg?: string) => {
          if (quiet) return
          if (s === 'loading') setEngineStatus(msg || '正在准备语音…')
          else if (s === 'speaking') {
            setEngineStatus('正在朗读…')
            setTtsPaused(false)
          } else if (s === 'idle') setEngineStatus(msg || '')
        },
        onSynthProgress: (p: { progress: number; message: string; stage: string }) => {
          updateTodayCost()
          if (quiet) return
          const pct = Math.round((p.progress || 0) * 100)
          setEngineStatus(`${p.message || p.stage} ${pct}%`)
        },
        onFileSaved: (r: { fileOk: boolean; idbOk: boolean; error?: string }) => {
          // 缓存已写入：刷新正文的已合成下划线标记
          setMarksVersion((v) => v + 1)
          if (r.fileOk) return
          void (async () => {
            // Android 11+ 未授「所有文件访问权限」时写不进共享 Documents，优先提示授权而非查存储
            let permTip = ''
            try {
              if (!(await isAllFilesAccessGranted())) {
                permTip = '\n原因：未授予「所有文件访问权限」。请到「我的」页点「去授权」，或在系统设置中给本 App 允许后重新朗读本章。'
              }
            } catch {
              /* 非原生环境无此插件 */
            }
            const detail = r.error ? `：${r.error}` : ''
            const msg =
              `⚠️ 音频文件保存失败${detail}${permTip}\n` +
              `本章已扣费且可继续播放，但"已合成音频"里没有文件。` +
              `稍后可再次从本章开头朗读（不重复扣费，会自动重存）。`
            agentLog(
              'ReaderPage:onFileSaved',
              'audio file save failed',
              { chapterId: chapter.id, bookId: book.id, err: r.error, idbOk: r.idbOk, permTip: permTip !== '' },
              'E',
            )
            setDebugOpenPersistent(true)
            showToast(msg, 16000)
          })()
        },
      }

      const playOpts = {
        bookId: book.id,
        bookTitle: book.title,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        paragraphs,
        startSentenceIndex: startSent,
        voiceKey: zhKey,
        noteVoiceKey: noteKey,
        rate: settings.ttsRate,
        budgetYuan: settings.dailyBudgetYuan,
        engine,
        localModelId: settings.localModelId,
        localSpeakerId: settings.localSpeakerId,
        ...callbacks,
      }

      // 重试前把起点推进到失败的句子（尚未开始播放则保持原起点）
      const resumeOpts = () => {
        if (lastSent > (playOpts.startSentenceIndex ?? 0)) playOpts.startSentenceIndex = lastSent
        return playOpts
      }

      try {
        await ttsRef.current.playChapter(playOpts)
      } catch (err) {
        if (!mountedRef.current) return
        // 合成时 key 被清/读不到 → 弹解锁框，解锁成功后重试一次
        if (err instanceof TtsKeyLockedError) {
          const ok = await requestUnlock()
          if (!mountedRef.current) return
          if (!ok) {
            speakingRef.current = false
            setTtsOn(false)
            return
          }
          // 解锁成功，重试一次（不再递归避免无限循环）
          try {
            await ttsRef.current.playChapter(resumeOpts())
          } catch (err2) {
            if (!mountedRef.current) return
            if (
              err2 instanceof Error &&
              (err2.name === 'SpeakAborted' || err2.message === 'aborted')
            ) {
              return
            }
            const hint2 = getLastDebugHint()
            const c2 = classifyTtsError(err2)
            agentLog(
              'ReaderPage:speakFrom',
              'playChapter retry failed',
              { err: err2 instanceof Error ? err2.message : String(err2), category: c2.title, hint: hint2 },
              'C',
            )
            setDebugOpenPersistent(true)
            const msg2 = `[重试失败] ${c2.title}${c2.advice ? '\n' + c2.advice : ''}\n${hint2}`
            showToast(msg2, 14000)
            speakingRef.current = false
            setTtsOn(false)
            return
          }
        } else if (err instanceof BudgetExceeded) {
          const msg = `⚠️ 今日花费已达预算上限 ¥${err.budgetYuan.toFixed(2)}（已花 ¥${err.todayYuan.toFixed(2)}）`
          agentLog('ReaderPage:speakFrom', 'budget exceeded', { todayYuan: err.todayYuan, budgetYuan: err.budgetYuan }, 'W')
          showToast(msg, 10000)
          speakingRef.current = false
          setTtsOn(false)
          return
        } else if (
          err instanceof Error &&
          (err.name === 'SpeakAborted' || err.message === 'aborted')
        ) {
          return
        } else {
          const hint = getLastDebugHint()
          const c = classifyTtsError(err)
          agentLog(
            'ReaderPage:speakFrom',
            'playChapter failed',
            { err: err instanceof Error ? err.message : String(err), category: c.title, hint },
            'C',
          )
          if (c.retryable) {
            try {
              await ttsRef.current.playChapter(resumeOpts())
            } catch (err2) {
              if (!mountedRef.current) return
              if (
                err2 instanceof Error &&
                (err2.name === 'SpeakAborted' || err2.message === 'aborted')
              ) {
                return
              }
              const c2 = classifyTtsError(err2)
              const hint2 = getLastDebugHint()
              agentLog(
                'ReaderPage:speakFrom',
                'playChapter auto-retry failed',
                { err: err2 instanceof Error ? err2.message : String(err2), category: c2.title, hint: hint2 },
                'C',
              )
              setDebugOpenPersistent(true)
              const msg2 = `[重试失败] ${c2.title}${c2.advice ? '\n' + c2.advice : ''}\n${hint2}`
              showToast(msg2, 14000)
              speakingRef.current = false
              setTtsOn(false)
              return
            }
          } else {
            setDebugOpenPersistent(true)
            const msg = `${c.title}${c.advice ? '\n' + c.advice : ''}\n${hint}`
            showToast(msg, 14000)
            speakingRef.current = false
            setTtsOn(false)
            return
          }
        }
      }

      if (!mountedRef.current) return
      // playChapter 正常 resolve → 本章播放完毕，进入下一章
      if (!speakingRef.current) return
      const idx = book.chapters.findIndex((c) => c.id === chapter.id)
      const nextId = findNextSpeakableChapterId(book.chapters, idx)
      if (nextId) {
        continueQuietRef.current = true
        pendingAutoSpeakRef.current = true
        setChapterId(nextId)
        setParaIndex(0)
        setActiveSentence(-1)
        saveProgress(nextId, 0, 'tts', '进入下一章')
        showToast('继续下一章…')
      } else {
        speakingRef.current = false
        setTtsOn(false)
        showToast('全书朗读完成')
      }
    },
    [
      book,
      chapter,
      paragraphs,
      saveProgress,
      settings.ttsRate,
      settings.ttsVoiceZh,
      settings.ttsVoiceNote,
      settings.dailyBudgetYuan,
      settings.autoScroll,
    ],
  )

  speakFromRef.current = speakFrom

  // 换章后自动续读：只盯 chapterId / 段落数，避免进度写入导致 book 引用变化而重跑
  useEffect(() => {
    if (!pendingAutoSpeakRef.current) return
    const b = bookRef.current
    if (!b || !chapterId) return

    if (paragraphs.length === 0) {
      const idx = b.chapters.findIndex((c) => c.id === chapterId)
      const nextId = findNextSpeakableChapterId(b.chapters, idx)
      if (nextId) {
        setChapterId(nextId)
        setParaIndex(0)
        saveProgressRef.current(nextId, 0, 'tts', '跳过空章')
        return
      }
      pendingAutoSpeakRef.current = false
      continueQuietRef.current = false
      speakingRef.current = false
      setTtsOn(false)
      showToast('全书朗读完成')
      return
    }

    pendingAutoSpeakRef.current = false
    if (!speakingRef.current) {
      speakingRef.current = true
      setTtsOn(true)
    }
    void speakFromRef.current(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意不依赖 book/speakFrom 引用
  }, [chapterId, paragraphs.length])

  useEffect(() => {
    if (paraIndex >= paragraphs.length) setParaIndex(0)
    paraRefs.current = paraRefs.current.slice(0, visibleParagraphs.length)
  }, [paragraphs, paraIndex, visibleParagraphs.length])

  if (!book || !chapter) {
    return (
      <div className="reader theme-day">
        <button type="button" className="btn-primary" style={{ margin: 24 }} onClick={closeReader}>
          ← 返回书架
        </button>
      </div>
    )
  }

  const toggleMenu = () => {
    if (panel) {
      setPanel(null)
      return
    }
    setMenuOpen((v) => !v)
  }

  /**
   * 左右翻页模式：整屏翻一页，横滑出→换页→横滑进的翻书动画；
   * 翻到本章头/尾继续翻则切换上/下一章（像真实翻书）。滚动事件照常更新阅读进度。
   */
  const pageTurn = (dir: 1 | -1) => {
    const el = contentRef.current
    if (!el || flippingRef.current) return
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
    // 已在本章末尾/开头还继续翻 → 切章
    if ((dir > 0 && el.scrollTop >= maxTop - 8) || (dir < 0 && el.scrollTop <= 8)) {
      goRelativeChapter(dir)
      return
    }
    const overlap = Math.round((settings.fontSize + 8) * settings.lineHeight * 2)
    const step = Math.max(120, el.clientHeight - overlap)
    const clamped = Math.max(0, Math.min(maxTop, el.scrollTop + dir * step))
    flippingRef.current = true
    let swapped = false
    // 横向滑出淡出 → 中点换滚动位置 → 从另一侧滑入淡入
    const anim = el.animate(
      [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: `translateX(${-dir * 30}%)`, opacity: 0, offset: 0.4 },
        { transform: `translateX(${dir * 30}%)`, opacity: 0, offset: 0.6 },
        { transform: 'translateX(0)', opacity: 1 },
      ],
      { duration: 320, easing: 'ease-in-out' },
    )
    window.setTimeout(() => {
      swapped = true
      el.scrollTo({ top: clamped })
    }, 150)
    anim.onfinish = () => {
      if (!swapped) el.scrollTo({ top: clamped })
      flippingRef.current = false
    }
  }

  const onTapContent = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    // 左右翻页模式：左侧 1/3 上一页、右侧 1/3 下一页、中间唤出菜单
    if (settings.pagingMode === 'flip') {
      const xr = (e.clientX - rect.left) / rect.width
      if (xr > 0.33 && xr < 0.67) {
        toggleMenu()
        return
      }
      pageTurn(xr <= 0.33 ? -1 : 1)
      return
    }
    const y = e.clientY
    const ratio = (y - rect.top) / rect.height
    if (ratio > 0.22 && ratio < 0.78) {
      toggleMenu()
      return
    }
    // 上/下翻以句子为单位
    const cur = activeSentence >= 0 ? activeSentence : (paraSentStart[paraIndex] ?? 0)
    if (ratio <= 0.28) {
      const n = Math.max(0, cur - 1)
      setActiveSentence(n)
      const pi = sentToParaRef.current[n] ?? 0
      setParaIndex(pi)
      saveProgress(chapter.id, pi, 'read', '上翻定位', false)
      scrollToPara(pi)
    } else {
      const n = Math.min(totalSentences - 1, cur + 1)
      setActiveSentence(n)
      const pi = sentToParaRef.current[n] ?? 0
      setParaIndex(pi)
      saveProgress(chapter.id, pi, 'read', '下翻定位', true)
      scrollToPara(pi)
    }
  }

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.changedTouches[0]
    touchRef.current = { x: t.clientX, y: t.clientY }
    suppressClickRef.current = false
  }

  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current
    touchRef.current = null
    if (!start || panel) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.3) return
    // 有效滑动：150ms 内抑制一次后续 click 事件，避免滑动结束又触发菜单/跳句
    suppressClickRef.current = true
    window.setTimeout(() => { suppressClickRef.current = false }, 300)
    if (settings.pagingMode === 'flip') {
      // 左右翻页模式：横滑翻一页（章节切换用底部滑条或目录）
      pageTurn(dx < 0 ? 1 : -1)
      return
    }
    goRelativeChapter(dx < 0 ? 1 : -1)
  }

  const togglePlay = () => {
    if (!ttsOn) {
      // 从当前段落的首句开始
      const startSent = paraSentStart[paraIndex] ?? 0
      void speakFrom(startSent)
      return
    }
    if (ttsPaused) {
      ttsRef.current.resume()
      setTtsPaused(false)
      return
    }
    ttsRef.current.pause()
    setTtsPaused(true)
    saveProgress(chapter.id, paraIndex, 'tts', '暂停朗读')
  }

  return (
    <div className={`reader theme-${settings.theme}`}>
      <div
        ref={contentRef}
        className="reader-content"
        style={{ fontSize: settings.fontSize, lineHeight: settings.lineHeight }}
        onClick={onTapContent}
        onScroll={onScrollContent}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <h2 className="chapter-title">{chapter.title}</h2>
        {visibleParagraphs.length === 0 ? (
          <p style={{ textIndent: 0, opacity: 0.7 }}>（本章暂无正文，可打开目录或左右滑动切换章节）</p>
        ) : (
          visibleParagraphs.map((p, i) => {
            const sents = paraSentences[i] ?? []
            const baseIdx = paraSentStart[i] ?? 0
            return (
              <p
                key={`${chapter.id}-${i}`}
                ref={(el) => {
                  paraRefs.current[i] = el
                }}
                className={p.kind === 'note' ? 'note-para' : ''}
              >
                {sents.map((sent, si) => {
                  const globalIdx = baseIdx + si
                  const isActive = globalIdx === activeSentence
                  return (
                    <span
                      key={si}
                      className={`sent-clickable${isActive ? ' active-sent' : ''}${synthedSentences.has(globalIdx) ? ' synthed' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setActiveSentence(globalIdx)
                        setParaIndex(i)
                        saveProgress(chapter.id, i, 'read', '点击定位', true)
                        if (ttsOn) {
                          stopTts()
                          void speakFrom(globalIdx)
                        }
                      }}
                    >
                      {sent}
                    </span>
                  )
                })}
              </p>
            )
          })
        )}
        {visibleParagraphs.length < paragraphs.length && (
          <button
            type="button"
            className="load-more-btn"
            onClick={(e) => {
              e.stopPropagation()
              loadMore()
            }}
          >
            加载更多正文（{visibleParagraphs.length}/{paragraphs.length}）
          </button>
        )}
        <div className="chapter-nav-row">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              goRelativeChapter(-1)
            }}
          >
            ← 上一章
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              goRelativeChapter(1)
            }}
          >
            下一章 →
          </button>
        </div>
      </div>

      <div className={`reader-topbar${menuOpen ? '' : ' hidden'}`} onClick={toggleMenu}>
        <button
          type="button"
          className="back"
          onClick={(e) => {
            e.stopPropagation()
            stopTts()
            closeReader()
          }}
        >
          ← 返回
        </button>
        <div className="title">{book.title}</div>
        <span style={{ fontSize: 12, color: '#aaa' }}>{book.progressPercent}%</span>
      </div>

      <div className={`reader-menubar${menuOpen ? '' : ' hidden'}`}>
        <div className="menu-actions">
          <button type="button" className={panel === 'toc' ? 'active' : ''} onClick={() => setPanel(panel === 'toc' ? null : 'toc')}>
            <span className="mi">目</span>
            目录
          </button>
          <button
            type="button"
            onClick={() => {
              saveProgress(chapter.id, paraIndex, 'read', '手动书签')
              showToast('已记录当前位置')
            }}
          >
            <span className="mi">记</span>
            记位置
          </button>
          <button type="button" className={panel === 'settings' ? 'active' : ''} onClick={() => {
            setPanel(panel === 'settings' ? null : 'settings')
          }}>
            <span className="mi">设</span>
            设置
          </button>
          <button
            type="button"
            className={ttsOn ? 'active' : ''}
            onClick={() => {
              if (ttsOn) stopTts()
              else {
                const startSent = paraSentStart[paraIndex] ?? 0
                void speakFrom(startSent)
              }
            }}
          >
            <span className="mi">听</span>
            听书
          </button>
          <button
            type="button"
            className={synthing ? 'active' : ''}
            title="只合成不播放：提前生成整章音频，再点一下停止"
            onClick={() => void toggleSynth()}
          >
            <span className="mi">合</span>
            {synthing ? '停止' : '合成'}
          </button>
        </div>

        {(ttsOn || menuOpen) && (
          <div className="tts-bar">
            <button
              type="button"
              className="side-btn"
              onClick={() => {
                const cur = activeSentence >= 0 ? activeSentence : (paraSentStart[paraIndex] ?? 0)
                const n = Math.max(0, cur - 1)
                setActiveSentence(n)
                const pi = sentToParaRef.current[n] ?? 0
                setParaIndex(pi)
                if (ttsOn) {
                  stopTts()
                  void speakFrom(n)
                }
              }}
            >
              上句
            </button>
            <button type="button" className="tts-btn" onClick={togglePlay}>
              {!ttsOn || ttsPaused ? '▶' : '❚❚'}
            </button>
            <div className="tts-info">
              <div>
                {synthing
                  ? (synthMsg || '正在合成…')
                  : ttsOn
                  ? (ttsPaused ? '已暂停' : '正在朗读…')
                  : '点击播放开始朗读'}
              </div>
              <div className="muted">
                {chapter.title} · 第 {activeSentence >= 0 ? activeSentence + 1 : (paraSentStart[paraIndex] ?? 0) + 1}/{totalSentences || 1} 句 · {settings.ttsRate.toFixed(1)}x
              </div>
              <div className="muted" style={{ fontSize: 11 }}>
                今日已耗 {todayCost}
                {chapterCostLabel ? ` · 本章 ${chapterCostLabel}` : ''}
              </div>
            </div>
            <button
              type="button"
              className="side-btn"
              onClick={() => {
                const cur = activeSentence >= 0 ? activeSentence : (paraSentStart[paraIndex] ?? 0)
                const n = Math.min(totalSentences - 1, cur + 1)
                setActiveSentence(n)
                const pi = sentToParaRef.current[n] ?? 0
                setParaIndex(pi)
                if (ttsOn) {
                  stopTts()
                  void speakFrom(n)
                }
              }}
            >
              下句
            </button>
            <button
              type="button"
              className="side-btn"
              title="睡眠定时：时间到自动停止朗读"
              onClick={promptSleepTimer}
              style={
                sleepRemainSec != null
                  ? { color: 'var(--accent)', border: '1px solid var(--accent)', fontSize: 12, minWidth: 52 }
                  : { minWidth: 52 }
              }
            >
              {sleepRemainSec != null ? fmtSleepRemain(sleepRemainSec) : '定时'}
            </button>
          </div>
        )}

        {/* 章节快速跳转滑动条 */}
        <div className="chapter-slider-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 16px 8px' }}>
          <span style={{ fontSize: 11, whiteSpace: 'nowrap', minWidth: 28, textAlign: 'right' }}>
            {(currentChapterIndex >= 0 ? currentChapterIndex : 0) + 1}/{book.chapters.length}
          </span>
          <input
            type="range"
            min={0}
            max={book.chapters.length - 1}
            value={currentChapterIndex >= 0 ? currentChapterIndex : 0}
            onChange={(e) => {
              const idx = parseInt(e.target.value, 10)
              const cid = book.chapters[idx]?.id
              if (cid && cid !== chapterId) {
                jumpChapter(cid)
                showToast(book.chapters[idx].title)
              }
            }}
            style={{ flex: 1, height: 4, accentColor: 'var(--accent)' }}
          />
          <span style={{ fontSize: 11, whiteSpace: 'nowrap', minWidth: 28 }}>
            {book.chapters.length}
          </span>
        </div>
      </div>

      {panel && <div className="overlay-mask" onClick={() => setPanel(null)} />}

      {panel === 'toc' && (
        <TocPanel
          book={book}
          currentChapterId={chapter.id}
          onJump={(cid) => {
            jumpChapter(cid)
            showToast('已跳转')
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'settings' && (
        <ReaderSettingsPanel
          settings={settings}
          engineStatus={engineStatus}
          onUpdateSettings={(partial) => {
            updateSettings(partial)
            if ('ttsDebugPanel' in partial) {
              setDebugOpenPersistent(!!partial.ttsDebugPanel)
            }
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {toast && <div className="toast toast-debug">{toast}</div>}

      {unlockOpen && (
        <UnlockModal
          error={unlockError}
          loading={unlockLoading}
          onSubmit={onSubmitUnlock}
          onCancel={onCancelUnlock}
        />
      )}

      {settings.ttsDebugPanel && (
        <DebugPanel
          debugOpen={debugOpen}
          debugLines={debugLines}
          onToggle={() => setDebugOpenPersistent((v) => !v)}
        />
      )}
    </div>
  )
}


