import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TocPanel } from '../components/TocPanel'
import { ReaderSettingsPanel } from '../components/ReaderSettingsPanel'
import { useAppStore } from '../store/useAppStore'
import { splitParagraphs, splitSentences } from '../utils/chapterParser'
import { createAudioPlayer, type AudioPlayerController } from '../utils/audioPlayer'
import { getChapterAudioUrl } from '../utils/audioPackageStore'

type Panel = null | 'toc' | 'settings'

const INITIAL_VISIBLE = 60
const LOAD_MORE = 60
const TINY_CHAPTER = 40

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
  const needSkip =
    !current?.content?.trim() || ((current.content?.length || 0) < TINY_CHAPTER && pIndex === 0)
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
  const [chapterId, setChapterId] = useState('')
  const [posIndex, setPosIndex] = useState(0) // 音频=渲染单元下标；纯文本=段落下标
  const [activeSentence, setActiveSentence] = useState(-1) // 正文句 index
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null)
  const [speakingTitle, setSpeakingTitle] = useState(false) // 正在念本章标题
  const [playing, setPlaying] = useState(false)
  const [paused, setPaused] = useState(false)
  const [toast, setToast] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)

  const [sleepRemainSec, setSleepRemainSec] = useState<number | null>(null)
  const sleepDeadlineRef = useRef<number | null>(null)
  const sleepIntervalRef = useRef<number | null>(null)

  const contentRef = useRef<HTMLDivElement>(null)
  const unitRefs = useRef<(HTMLSpanElement | HTMLParagraphElement | null)[]>([])
  const pendingScrollRef = useRef<number | null>(null)
  const lastScrollSaveRef = useRef(0)
  const chapterIdRef = useRef(chapterId)
  const bookRef = useRef(book)
  bookRef.current = book
  const mountedRef = useRef(true)
  const toastTimerRef = useRef<number | null>(null)
  const touchRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const flippingRef = useRef(false)

  const playerRef = useRef<AudioPlayerController>(createAudioPlayer())
  const audioUrlCacheRef = useRef<Map<string, string>>(new Map())
  const saveProgressRef = useRef<
    (cid: string, idx: number, source: 'read' | 'audio', note?: string, recordSnapshot?: boolean) => void
  >(() => {})

  const currentChapterIndex = useMemo(
    () => (book ? book.chapters.findIndex((c) => c.id === chapterId) : -1),
    [book, chapterId],
  )
  const chapter = useMemo(
    () => book?.chapters.find((c) => c.id === chapterId) ?? book?.chapters[0],
    [book, chapterId],
  )

  /** 本章是否带音频（来自音频包 manifest） */
  const audioCh = useMemo(
    () => (book && chapter ? book.audioChapters?.[chapter.id] : undefined),
    [book, chapter],
  )
  const isAudio = !!audioCh

  /** 本章是否朗读标题（旧包无 titleStartMs 时为空 → 标题只显示、不朗读） */
  const chapterHasTitleAudio = (audioCh?.titleStartMs ?? 0) > 0 && (audioCh?.titleEndMs ?? 0) > 0

  /* ---- 音频章节：渲染单元 = 正文句 + 注释 ---- */
  const audioUnits = useMemo(() => {
    if (!audioCh) return []
    const units: { kind: 'text' | 'note'; text: string; sentenceIndex: number; noteId: string | null }[] = []
    for (const s of audioCh.sentences) {
      units.push({ kind: 'text', text: s.text, sentenceIndex: s.index, noteId: null })
    }
    for (const n of audioCh.notes) {
      units.push({ kind: 'note', text: n.text, sentenceIndex: -1, noteId: n.id })
    }
    return units
  }, [audioCh])
  const sentenceUnitMap = useMemo(() => {
    const m = new Map<number, number>()
    audioUnits.forEach((u, i) => {
      if (u.kind === 'text') m.set(u.sentenceIndex, i)
    })
    return m
  }, [audioUnits])
  const noteUnitMap = useMemo(() => {
    const m = new Map<string, number>()
    audioUnits.forEach((u, i) => {
      if (u.noteId) m.set(u.noteId, i)
    })
    return m
  }, [audioUnits])

  /* ---- 纯文本章节：段落 + 句子 ---- */
  const paragraphs = useMemo(
    () => (chapter && !isAudio ? splitParagraphs(chapter.content || '') : []),
    [chapter, isAudio],
  )
  const paraSentences = useMemo(() => paragraphs.map((p) => splitSentences(p.text)), [paragraphs])
  const paraSentStart = useMemo(() => {
    const starts: number[] = []
    let acc = 0
    for (const sents of paraSentences) {
      starts.push(acc)
      acc += sents.length
    }
    return starts
  }, [paraSentences])
  const totalSentences =
    paraSentStart.length > 0 ? paraSentStart[paraSentStart.length - 1] + paraSentences[paraSentences.length - 1].length : 0
  const sentToParaRef = useRef<number[]>([])
  sentToParaRef.current = useMemo(() => {
    const map: number[] = []
    paraSentences.forEach((sents, pi) => {
      for (let si = 0; si < sents.length; si++) map.push(pi)
    })
    return map
  }, [paraSentences])

  /** 渲染总单元数（音频=units；文本=paragraphs） */
  const totalUnits = isAudio ? audioUnits.length : paragraphs.length
  const visibleAudioUnits = useMemo(
    () => audioUnits.slice(0, Math.min(visibleCount, audioUnits.length)),
    [audioUnits, visibleCount],
  )
  const visibleParagraphs = useMemo(
    () => paragraphs.slice(0, Math.min(visibleCount, paragraphs.length)),
    [paragraphs, visibleCount],
  )

  useEffect(() => {
    chapterIdRef.current = chapterId
  }, [chapterId])

  useEffect(() => {
    if (!book) return
    const { cid, pIndex } = pickStartChapter(book)
    setChapterId(cid)
    setPosIndex(pIndex)
    setVisibleCount(INITIAL_VISIBLE)
    setMenuOpen(true)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id])

  useEffect(() => {
    if (pendingScrollRef.current != null) return
    setVisibleCount(INITIAL_VISIBLE)
    contentRef.current?.scrollTo({ top: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.id])

  useEffect(() => {
    const target = pendingScrollRef.current
    if (target == null) return
    const el = unitRefs.current[target]
    if (!el) return
    pendingScrollRef.current = null
    el.scrollIntoView({ block: 'center' })
  }, [visibleCount, chapterId, totalUnits])

  useEffect(() => {
    if (posIndex + 5 >= visibleCount && visibleCount < totalUnits) {
      setVisibleCount((v) => Math.min(totalUnits, Math.max(v, posIndex + INITIAL_VISIBLE)))
    }
  }, [posIndex, visibleCount, totalUnits])

  useEffect(() => {
    return () => {
      playerRef.current.stop()
      mountedRef.current = false
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
      if (sleepIntervalRef.current !== null) window.clearInterval(sleepIntervalRef.current)
    }
  }, [])

  const showToast = (msg: string, ms = 2800) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast(msg)
    toastTimerRef.current = window.setTimeout(() => {
      setToast('')
      toastTimerRef.current = null
    }, ms)
  }

  const stopPlayer = useCallback(() => {
    playerRef.current.stop()
    setPlaying(false)
    setPaused(false)
    setActiveSentence(-1)
    setActiveNoteId(null)
    setSpeakingTitle(false)
  }, [])

  const saveProgress = useCallback(
    (cid: string, idx: number, source: 'read' | 'audio', note?: string, recordSnapshot = true) => {
      if (!book) return
      updateReadingProgress({
        bookId: book.id,
        chapterId: cid,
        paragraphIndex: idx,
        source,
        note,
        recordSnapshot,
        paragraphCount: isAudio ? totalUnits : undefined,
      })
    },
    [book, updateReadingProgress, isAudio, totalUnits],
  )
  saveProgressRef.current = saveProgress

  const scrollToUnit = (index: number) => {
    const el = unitRefs.current[index]
    if (el && settings.autoScroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const loadMore = useCallback(() => {
    setVisibleCount((v) => (v >= totalUnits ? v : Math.min(totalUnits, v + LOAD_MORE)))
  }, [totalUnits])

  const onScrollContent = () => {
    const el = contentRef.current
    if (!el) return
    const remain = el.scrollHeight - el.scrollTop - el.clientHeight
    if (remain < 400) loadMore()
    if (playing) return
    const now = Date.now()
    if (now - lastScrollSaveRef.current < 800) return
    if (!chapter) return
    const boxTop = el.getBoundingClientRect().top
    let idx = -1
    const refs = unitRefs.current
    for (let i = 0; i < refs.length; i++) {
      const p = refs[i]
      if (!p) break
      if (p.getBoundingClientRect().top - boxTop <= 140) idx = i
      else break
    }
    if (idx < 0 || idx === posIndex) return
    lastScrollSaveRef.current = now
    setPosIndex(idx)
    saveProgress(chapter.id, idx, 'read', '滚动定位', false)
  }

  /** 播放音频：从指定正文句开始 */
  const playFrom = useCallback(
    async (startSentence: number) => {
      if (!book || !chapter || !audioCh) {
        showToast('本章暂无音频，可在 PC 端合成后导入音频包')
        return
      }
      let url = audioUrlCacheRef.current.get(chapter.id)
      if (!url) {
        url = (await getChapterAudioUrl(book.id, chapter.id)) ?? undefined
        if (url) audioUrlCacheRef.current.set(chapter.id, url)
      }
      if (!url) {
        showToast('找不到本章音频文件，请重新导入音频包')
        return
      }
      setPlaying(true)
      setPaused(false)
      setMenuOpen(true)
      await playerRef.current.playChapter({
        url,
        chapter: audioCh,
        rate: settings.playbackRate,
        startSentenceIndex: startSentence,
        callbacks: {
          onTitle: () => {
            if (!mountedRef.current) return
            setSpeakingTitle(true)
            setActiveSentence(-1)
            setActiveNoteId(null)
          },
          onSentence: (i) => {
            if (!mountedRef.current) return
            setSpeakingTitle(false)
            setActiveSentence(i)
            setActiveNoteId(null)
            const u = sentenceUnitMap.get(i) ?? 0
            setPosIndex(u)
            scrollToUnit(u)
            saveProgressRef.current(chapter.id, u, 'audio', '朗读进度', false)
          },
          onNote: (id) => {
            if (!mountedRef.current) return
            setSpeakingTitle(false)
            setActiveNoteId(id)
            const u = noteUnitMap.get(id)
            if (u != null) {
              setPosIndex(u)
              scrollToUnit(u)
            }
          },
          onStatus: (s) => {
            if (s === 'paused') setPaused(true)
            else if (s === 'playing') setPaused(false)
          },
          onChapterEnd: () => {
            if (!mountedRef.current) return
            const idx = bookRef.current?.chapters.findIndex((c) => c.id === chapter.id) ?? -1
            const next = findNextAudioChapterId(bookRef.current?.chapters ?? [], idx, bookRef.current?.audioChapters ?? {})
            if (next) {
              continueQuietRef.current = true
              setChapterId(next)
              setPosIndex(0)
              setActiveSentence(-1)
              setActiveNoteId(null)
              setSpeakingTitle(false)
              saveProgressRef.current(next, 0, 'audio', '进入下一章')
              showToast('继续下一章…')
            } else {
              setPlaying(false)
              setPaused(false)
              showToast('全书朗读完成')
            }
          },
        },
      })
    },
    [book, chapter, audioCh, settings.playbackRate, sentenceUnitMap, noteUnitMap],
  )

  const playFromRef = useRef(playFrom)
  playFromRef.current = playFrom
  const continueQuietRef = useRef(false)

  // 换章后自动续读
  useEffect(() => {
    if (!continueQuietRef.current) return
    continueQuietRef.current = false
    const b = bookRef.current
    if (!b || !chapterId) return
    const ch = b.chapters.find((c) => c.id === chapterId)
    if (!ch) return
    const ac = b.audioChapters?.[chapterId]
    if (!ac) {
      // 下一章无音频 → 停
      setPlaying(false)
      return
    }
    void playFromRef.current(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId])

  useEffect(() => {
    if (posIndex >= totalUnits) setPosIndex(0)
    unitRefs.current = unitRefs.current.slice(0, Math.min(visibleCount, totalUnits))
  }, [totalUnits, posIndex, visibleCount])

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

  const goRelativeChapter = (delta: number) => {
    const idx = book.chapters.findIndex((c) => c.id === chapterIdRef.current)
    const next = book.chapters[idx + delta]
    if (!next) {
      showToast(delta < 0 ? '已是第一章' : '已是最后一章')
      return
    }
    jumpChapter(next.id)
    showToast(next.title)
  }

  const jumpChapter = (cid: string) => {
    pendingScrollRef.current = null
    stopPlayer()
    setChapterId(cid)
    setPosIndex(0)
    setActiveSentence(-1)
    setActiveNoteId(null)
    setSpeakingTitle(false)
    setPanel(null)
    saveProgress(cid, 0, 'read', '切换章节')
  }

  const pageTurn = (dir: 1 | -1) => {
    const el = contentRef.current
    if (!el || flippingRef.current) return
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
    if ((dir > 0 && el.scrollTop >= maxTop - 8) || (dir < 0 && el.scrollTop <= 8)) {
      goRelativeChapter(dir)
      return
    }
    const overlap = Math.round((settings.fontSize + 8) * settings.lineHeight * 2)
    const step = Math.max(120, el.clientHeight - overlap)
    const clamped = Math.max(0, Math.min(maxTop, el.scrollTop + dir * step))
    flippingRef.current = true
    let swapped = false
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
    const cur = isAudio
      ? (activeSentence >= 0 ? activeSentence : 0)
      : (activeSentence >= 0 ? activeSentence : paraSentStart[posIndex] ?? 0)
    const total = isAudio ? (audioCh?.sentences.length ?? 0) : totalSentences
    if (ratio <= 0.28) {
      const n = Math.max(0, cur - 1)
      jumpToSentence(n)
    } else {
      const n = Math.min(total - 1, cur + 1)
      jumpToSentence(n)
    }
  }

  const jumpToSentence = (n: number) => {
    if (isAudio) {
      const u = sentenceUnitMap.get(n) ?? 0
      setActiveSentence(n)
      setActiveNoteId(null)
      setPosIndex(u)
      scrollToUnit(u)
      saveProgress(chapter.id, u, 'read', '定位', true)
      if (playing) {
        playerRef.current.seekToSentence(n)
      }
    } else {
      setActiveSentence(n)
      const pi = sentToParaRef.current[n] ?? 0
      setPosIndex(pi)
      scrollToUnit(pi)
      saveProgress(chapter.id, pi, 'read', '定位', true)
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
    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 300)
    if (settings.pagingMode === 'flip') {
      pageTurn(dx < 0 ? 1 : -1)
      return
    }
    goRelativeChapter(dx < 0 ? 1 : -1)
  }

  const togglePlay = () => {
    if (!playing) {
      const start = isAudio ? (activeSentence >= 0 ? activeSentence : 0) : 0
      void playFrom(start)
      return
    }
    if (paused) {
      playerRef.current.resume()
      setPaused(false)
      return
    }
    playerRef.current.pause()
    setPaused(true)
    saveProgress(chapter.id, posIndex, 'audio', '暂停朗读')
  }

  const promptSleepTimer = () => {
    const activeMin = sleepDeadlineRef.current
      ? Math.max(1, Math.round((sleepDeadlineRef.current - Date.now()) / 60000))
      : settings.sleepMinutes || 0
    const input = window.prompt(
      '睡眠定时（分钟）\n时间到自动停止播放，输入 0 关闭。\n常用：15 / 30 / 60 / 90',
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
    updateSettings({ sleepMinutes: minutes })
    if (minutes === 0) {
      if (sleepIntervalRef.current !== null) window.clearInterval(sleepIntervalRef.current)
      sleepIntervalRef.current = null
      sleepDeadlineRef.current = null
      setSleepRemainSec(null)
      showToast('已关闭睡眠定时')
    } else {
      if (sleepIntervalRef.current !== null) window.clearInterval(sleepIntervalRef.current)
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
        window.clearInterval(sleepIntervalRef.current)
        sleepIntervalRef.current = null
        sleepDeadlineRef.current = null
        setSleepRemainSec(null)
        if (playing) {
          stopPlayer()
          showToast('定时时间到，已停止播放')
        }
      }, 1000)
      showToast(`${minutes} 分钟后自动停止播放`)
    }
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
        <h2
          className={`chapter-title${speakingTitle ? ' speaking' : ''}`}
          onClick={(e) => {
            if (!chapterHasTitleAudio) return
            e.stopPropagation()
            if (playing) {
              // 正在念标题 → 再点一次从头重念；否则跳回章首
              playerRef.current.seekToTitle()
            }
          }}
          title={chapterHasTitleAudio ? '点击回到本章开头重听标题' : undefined}
        >
          {chapter.title}
          {isAudio && <span className="audio-badge">有音频</span>}
        </h2>

        {isAudio ? (
          <>
            {visibleAudioUnits.map((u, i) => {
              const isNote = u.kind === 'note'
              const isActive = isNote ? u.noteId === activeNoteId : u.sentenceIndex === activeSentence
              return (
                <p key={`${chapter.id}-${i}`} ref={(el) => { unitRefs.current[i] = el }} className={isNote ? 'note-para' : ''}>
                  <span
                    className={`sent-clickable${isActive ? ' active-sent' : ''}${isNote ? ' note-sent' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (isNote && u.noteId) {
                        setActiveNoteId(u.noteId)
                        setPosIndex(i)
                        if (playing) playerRef.current.seekToNote(u.noteId)
                      } else if (!isNote) {
                        jumpToSentence(u.sentenceIndex)
                      }
                    }}
                  >
                    {u.text}
                  </span>
                </p>
              )
            })}
            {audioUnits.length > visibleAudioUnits.length && (
              <button
                type="button"
                className="load-more-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  loadMore()
                }}
              >
                加载更多（{visibleAudioUnits.length}/{audioUnits.length}）
              </button>
            )}
          </>
        ) : paragraphs.length === 0 ? (
          <p style={{ textIndent: 0, opacity: 0.7 }}>（本章暂无正文，可打开目录或左右滑动切换章节）</p>
        ) : (
          <>
            {visibleParagraphs.map((p, i) => {
              const sents = paraSentences[i] ?? []
              const baseIdx = paraSentStart[i] ?? 0
              return (
                <p key={`${chapter.id}-${i}`} ref={(el) => { unitRefs.current[i] = el }} className={p.kind === 'note' ? 'note-para' : ''}>
                  {sents.map((sent, si) => {
                    const globalIdx = baseIdx + si
                    const isActive = globalIdx === activeSentence
                    return (
                      <span
                        key={si}
                        className={`sent-clickable${isActive ? ' active-sent' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          jumpToSentence(globalIdx)
                        }}
                      >
                        {sent}
                      </span>
                    )
                  })}
                </p>
              )
            })}
            {paragraphs.length > visibleParagraphs.length && (
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
          </>
        )}

        <div className="chapter-nav-row">
          <button type="button" onClick={(e) => { e.stopPropagation(); goRelativeChapter(-1) }}>
            ← 上一章
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); goRelativeChapter(1) }}>
            下一章 →
          </button>
        </div>
      </div>

      <div className={`reader-topbar${menuOpen ? '' : ' hidden'}`} onClick={toggleMenu}>
        <button type="button" className="back" onClick={(e) => { e.stopPropagation(); stopPlayer(); closeReader() }}>
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
          <button type="button" onClick={() => { saveProgress(chapter.id, posIndex, 'read', '手动书签'); showToast('已记录当前位置') }}>
            <span className="mi">记</span>
            记位置
          </button>
          <button type="button" className={panel === 'settings' ? 'active' : ''} onClick={() => setPanel(panel === 'settings' ? null : 'settings')}>
            <span className="mi">设</span>
            设置
          </button>
          <button
            type="button"
            className={playing ? 'active' : ''}
            onClick={() => { if (playing) stopPlayer(); else void playFrom(activeSentence >= 0 ? activeSentence : 0) }}
          >
            <span className="mi">听</span>
            听书
          </button>
        </div>

        {playing && (
          <div className="audio-bar">
            <button
              type="button"
              className="side-btn"
              onClick={() => {
                const cur = activeSentence >= 0 ? activeSentence : 0
                jumpToSentence(Math.max(0, cur - 1))
                if (playing) playerRef.current.seekToSentence(Math.max(0, cur - 1))
              }}
            >
              上句
            </button>
            <button type="button" className="audio-btn" onClick={togglePlay}>
              {paused ? '▶' : '❚❚'}
            </button>
            <div className="audio-info">
              <div>{paused ? '已暂停' : activeNoteId ? '播放注释…' : '正在播放…'}</div>
              <div className="muted">
                {chapter.title} · {isAudio ? `第 ${(activeSentence >= 0 ? activeSentence : 0) + 1}/${audioCh?.sentences.length ?? 1} 句` : `共 ${totalSentences || 1} 句`} · {settings.playbackRate.toFixed(1)}x
              </div>
            </div>
            <button
              type="button"
              className="side-btn"
              onClick={() => {
                const total = isAudio ? (audioCh?.sentences.length ?? 0) : totalSentences
                const cur = activeSentence >= 0 ? activeSentence : 0
                const n = Math.min(total - 1, cur + 1)
                jumpToSentence(n)
                if (playing) playerRef.current.seekToSentence(n)
              }}
            >
              下句
            </button>
            <button
              type="button"
              className="side-btn"
              title="睡眠定时：时间到自动停止播放"
              onClick={promptSleepTimer}
              style={sleepRemainSec != null ? { color: 'var(--accent)', border: '1px solid var(--accent)', fontSize: 12, minWidth: 52 } : { minWidth: 52 }}
            >
              {sleepRemainSec != null ? fmtSleepRemain(sleepRemainSec) : '定时'}
            </button>
          </div>
        )}

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
          <span style={{ fontSize: 11, whiteSpace: 'nowrap', minWidth: 28 }}>{book.chapters.length}</span>
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
          onUpdateSettings={updateSettings}
          onClose={() => setPanel(null)}
        />
      )}

      {toast && <div className="toast toast-debug">{toast}</div>}
    </div>
  )
}

/** 从 afterIndex 之后找下一章有音频的章节 */
function findNextAudioChapterId(
  chapters: { id: string }[],
  afterIndex: number,
  audioChapters: Record<string, unknown>,
): string | null {
  for (let i = afterIndex + 1; i < chapters.length; i++) {
    if (audioChapters[chapters[i].id]) return chapters[i].id
  }
  return null
}
