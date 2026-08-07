import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TocPanel } from '../components/TocPanel'
import { useAppStore } from '../store/useAppStore'
import { splitParagraphs } from '../utils/chapterParser'
import {
  createTtsController,
  DEFAULT_VOICE_NOTE,
  DEFAULT_VOICE_ZH,
  voicesForLang,
  VOICE_CATALOG,
} from '../utils/tts'
import { migrateVoiceKey } from '../utils/ttsVoices'
import { hasTtsKey, unlockTtsKey, TtsKeyLockedError } from '../utils/ttsKeyStore'
import {
  agentLog,
  formatDebugLine,
  getLastDebugHint,
  subscribeDebugLog,
  type DebugPayload,
} from '../utils/agentLog'

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

function pickStartChapter(book: {
  chapterId: string
  paragraphIndex: number
  chapters: { id: string; content: string }[]
}) {
  let cid = book.chapterId || book.chapters[0]?.id || ''
  let pIndex = book.paragraphIndex || 0
  const current = book.chapters.find((c) => c.id === cid) ?? book.chapters[0]
  if (current && (current.content?.length || 0) < TINY_CHAPTER && pIndex === 0) {
    const better = book.chapters.find((c) => (c.content?.length || 0) >= TINY_CHAPTER)
    if (better) {
      cid = better.id
      pIndex = 0
    }
  }
  return { cid, pIndex }
}

export function ReaderPage() {
  const activeBookId = useAppStore((s) => s.activeBookId)
  const book = useAppStore((s) => s.books.find((b) => b.id === activeBookId))
  const settings = useAppStore((s) => s.settings)
  const closeReader = useAppStore((s) => s.closeReader)
  const updateReadingProgress = useAppStore((s) => s.updateReadingProgress)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const [menuOpen, setMenuOpen] = useState(true)
  const [panel, setPanel] = useState<Panel>(null)
  const [paraIndex, setParaIndex] = useState(0)
  const [chapterId, setChapterId] = useState('')
  const [ttsOn, setTtsOn] = useState(false)
  const [ttsPaused, setTtsPaused] = useState(false)
  const [toast, setToast] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)
  const [engineStatus, setEngineStatus] = useState(
    '在线语音 · MiniMax speech-2.8-turbo（¥2/万字，首次合成需联网，之后缓存）',
  )
  const [debugLines, setDebugLines] = useState<DebugPayload[]>([])
  const [debugOpen, setDebugOpen] = useState(true)
  /** 语音解锁弹窗：首次朗读时要求输入密码，解密 MiniMax key */
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [unlockError, setUnlockError] = useState('')
  const [unlockLoading, setUnlockLoading] = useState(false)
  const unlockResolverRef = useRef<((ok: boolean) => void) | null>(null)
  /** 费用预估弹窗：合成前提示预计花费 */
  const [costOpen, setCostOpen] = useState(false)
  const [costChars, setCostChars] = useState(0)
  const [costYuan, setCostYuan] = useState(0)
  const costResolverRef = useRef<((ok: boolean) => void) | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const paraRefs = useRef<(HTMLParagraphElement | null)[]>([])
  const ttsRef = useRef(createTtsController())
  const speakingRef = useRef(false)
  const pendingAutoSpeakRef = useRef(false)
  /** 连章续读：跳过「正在准备」toast */
  const continueQuietRef = useRef(false)
  const touchRef = useRef<{ x: number; y: number } | null>(null)
  const chapterIdRef = useRef(chapterId)
  const speakFromRef = useRef<(start: number) => Promise<void>>(async () => {})
  const bookRef = useRef(book)
  bookRef.current = book

  const chapter = useMemo(
    () => book?.chapters.find((c) => c.id === chapterId) ?? book?.chapters[0],
    [book, chapterId],
  )

  const paragraphs = useMemo(
    () => (chapter ? splitParagraphs(chapter.content || '') : []),
    [chapter],
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
    setParaIndex(pIndex)
    setVisibleCount(INITIAL_VISIBLE)
    setMenuOpen(true)
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
    setVisibleCount(INITIAL_VISIBLE)
    contentRef.current?.scrollTo({ top: 0 })
  }, [chapter?.id])

  useEffect(() => {
    if (paraIndex + 5 >= visibleCount && visibleCount < paragraphs.length) {
      setVisibleCount((v) => Math.min(paragraphs.length, Math.max(v, paraIndex + INITIAL_VISIBLE)))
    }
  }, [paraIndex, visibleCount, paragraphs.length])

  useEffect(() => {
    return () => {
      ttsRef.current.stop()
    }
  }, [])

  const showToast = (msg: string, ms = 2800) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), ms)
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

  /** 弹窗内：提交密码尝试解锁 */
  const onSubmitUnlock = useCallback(
    async (password: string) => {
      setUnlockLoading(true)
      setUnlockError('')
      try {
        const ok = await unlockTtsKey(password)
        if (ok) {
          setUnlockOpen(false)
          unlockResolverRef.current?.(true)
          unlockResolverRef.current = null
        } else {
          setUnlockError('密码错误，请重试')
        }
      } catch {
        setUnlockError('解锁失败，请重试')
      } finally {
        setUnlockLoading(false)
      }
    },
    [],
  )

  /** 弹窗内：取消 */
  const onCancelUnlock = useCallback(() => {
    setUnlockOpen(false)
    unlockResolverRef.current?.(false)
    unlockResolverRef.current = null
  }, [])

  /** 费用预估弹窗：请求用户确认，返回是否同意付费 */
  const requestCostConfirm = useCallback(
    (chars: number, costY: number): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        setCostChars(chars)
        setCostYuan(costY)
        costResolverRef.current = resolve
        setCostOpen(true)
      })
    },
    [],
  )

  const onConfirmCost = useCallback(() => {
    setCostOpen(false)
    costResolverRef.current?.(true)
    costResolverRef.current = null
  }, [])

  const onCancelCost = useCallback(() => {
    setCostOpen(false)
    costResolverRef.current?.(false)
    costResolverRef.current = null
  }, [])

  // #region agent log
  useEffect(() => subscribeDebugLog(setDebugLines), [])
  // #endregion

  // 旧版本残留的本地音色 key（华严 / sherpa / 早期英文音色）迁移到默认在线音色
  useEffect(() => {
    const next = {
      ttsVoiceZh: migrateVoiceKey(settings.ttsVoiceZh) || DEFAULT_VOICE_ZH,
      ttsVoiceEn: migrateVoiceKey(settings.ttsVoiceEn) || DEFAULT_VOICE_ZH,
      ttsVoiceNote: migrateVoiceKey(settings.ttsVoiceNote) || DEFAULT_VOICE_ZH,
    }
    if (
      next.ttsVoiceZh !== settings.ttsVoiceZh ||
      next.ttsVoiceEn !== settings.ttsVoiceEn ||
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
  }, [])

  const jumpChapter = useCallback(
    (cid: string) => {
      // #region agent log
      agentLog('ReaderPage:jumpChapter', 'jump', { cid, wasSpeaking: speakingRef.current }, 'D')
      // #endregion
      pendingAutoSpeakRef.current = false
      continueQuietRef.current = false
      try {
        stopTts()
      } catch {
        /* ignore */
      }
      setChapterId(cid)
      setParaIndex(0)
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
    async (startIndex: number) => {
      if (!book || !chapter) return

      // 首次朗读需解锁语音（输入密码解密 MiniMax key）；已解锁则跳过
      if (!(await hasTtsKey())) {
        const ok = await requestUnlock()
        if (!ok) return // 用户取消
      }

      const quiet = continueQuietRef.current
      continueQuietRef.current = false
      speakingRef.current = true
      setTtsOn(true)
      setTtsPaused(false)
      setMenuOpen(true)

      const zhKey = migrateVoiceKey(settings.ttsVoiceZh) || DEFAULT_VOICE_ZH
      const noteKey = migrateVoiceKey(settings.ttsVoiceNote) || DEFAULT_VOICE_NOTE
      // #region agent log
      agentLog('ReaderPage:speakFrom', 'start', { zhKey, noteKey, startIndex, quiet, chapterId: chapter.id }, 'D')
      // #endregion

      if (!quiet) showToast('正在准备语音…', 4000)

      try {
        await ttsRef.current.playChapter({
          bookId: book.id,
          chapterId: chapter.id,
          paragraphs,
          startParagraphIndex: startIndex,
          voiceKey: zhKey,
          noteVoiceKey: noteKey,
          rate: settings.ttsRate,
          onParagraph: (i) => {
            if (!speakingRef.current) return
            setParaIndex(i)
            scrollToPara(i)
            saveProgress(chapter.id, i, 'tts', '朗读进度', true)
          },
          onStatus: (s, msg) => {
            if (quiet) return
            if (s === 'loading') setEngineStatus(msg || '正在准备语音…')
            else if (s === 'speaking') {
              setEngineStatus('正在朗读…')
              setTtsPaused(false)
            } else if (s === 'idle') setEngineStatus(msg || '')
          },
          onSynthProgress: (p) => {
            if (quiet) return
            const pct = Math.round((p.progress || 0) * 100)
            setEngineStatus(`${p.message || p.stage} ${pct}%`)
          },
          onCostEstimate: requestCostConfirm,
        })
      } catch (err) {
        // 合成时 key 被清/读不到 → 弹解锁框，解锁成功后重试一次
        if (err instanceof TtsKeyLockedError) {
          const ok = await requestUnlock()
          if (!ok) {
            speakingRef.current = false
            setTtsOn(false)
            return
          }
          // 解锁成功，重试一次（不再递归避免无限循环）
          try {
            await ttsRef.current.playChapter({
              bookId: book.id,
              chapterId: chapter.id,
              paragraphs,
              startParagraphIndex: startIndex,
              voiceKey: zhKey,
              noteVoiceKey: noteKey,
              rate: settings.ttsRate,
              onParagraph: (i) => {
                if (!speakingRef.current) return
                setParaIndex(i)
                scrollToPara(i)
                saveProgress(chapter.id, i, 'tts', '朗读进度', true)
              },
              onStatus: (s, msg) => {
                if (quiet) return
                if (s === 'loading') setEngineStatus(msg || '正在准备语音…')
                else if (s === 'speaking') {
                  setEngineStatus('正在朗读…')
                  setTtsPaused(false)
                } else if (s === 'idle') setEngineStatus(msg || '')
              },
              onSynthProgress: (p) => {
                if (quiet) return
                const pct = Math.round((p.progress || 0) * 100)
                setEngineStatus(`${p.message || p.stage} ${pct}%`)
              },
              onCostEstimate: requestCostConfirm,
            })
          } catch (err2) {
            if (
              err2 instanceof Error &&
              (err2.name === 'SpeakAborted' || err2.message === 'aborted')
            ) {
              return
            }
            const hint2 = getLastDebugHint()
            agentLog(
              'ReaderPage:speakFrom',
              'playChapter retry failed',
              { err: err2 instanceof Error ? err2.message : String(err2), hint: hint2 },
              'C',
            )
            setDebugOpen(true)
            showToast(`${err2 instanceof Error ? err2.message : '朗读失败'}\n${hint2}`, 12000)
            speakingRef.current = false
            setTtsOn(false)
            return
          }
          // 重试成功 → 走正常结束流程（跳到下方「本章播放完毕」逻辑）
        } else if (
          err instanceof Error &&
          (err.name === 'SpeakAborted' || err.message === 'aborted')
        ) {
          // 用户 stop / 切换段落，正常中止
          return
        } else {
          const hint = getLastDebugHint()
          // #region agent log
          agentLog(
            'ReaderPage:speakFrom',
            'playChapter failed',
            { err: err instanceof Error ? err.message : String(err), hint },
            'C',
          )
          // #endregion
          setDebugOpen(true)
          showToast(`${err instanceof Error ? err.message : '朗读失败'}\n${hint}`, 12000)
          speakingRef.current = false
          setTtsOn(false)
          return
        }
      }

      // playChapter 正常 resolve → 本章播放完毕，进入下一章
      if (!speakingRef.current) return
      const idx = book.chapters.findIndex((c) => c.id === chapter.id)
      const nextId = findNextSpeakableChapterId(book.chapters, idx)
      if (nextId) {
        continueQuietRef.current = true
        pendingAutoSpeakRef.current = true
        setChapterId(nextId)
        setParaIndex(0)
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
        saveProgress(nextId, 0, 'tts', '跳过空章')
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
  }, [chapterId, paragraphs.length, saveProgress])

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

  const onTapContent = (e: React.MouseEvent<HTMLDivElement>) => {
    const y = e.clientY
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (y - rect.top) / rect.height
    if (ratio > 0.28 && ratio < 0.72) {
      toggleMenu()
      return
    }
    if (ratio <= 0.28) {
      const next = Math.max(0, paraIndex - 1)
      setParaIndex(next)
      saveProgress(chapter.id, next, 'read', '上翻定位', false)
      scrollToPara(next)
    } else {
      const next = Math.min(paragraphs.length - 1, paraIndex + 1)
      setParaIndex(next)
      saveProgress(chapter.id, next, 'read', '下翻定位', true)
      scrollToPara(next)
    }
  }

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.changedTouches[0]
    touchRef.current = { x: t.clientX, y: t.clientY }
  }

  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current
    touchRef.current = null
    if (!start || panel) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.3) return
    goRelativeChapter(dx < 0 ? 1 : -1)
  }

  const togglePlay = () => {
    if (!ttsOn) {
      void speakFrom(paraIndex)
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
          visibleParagraphs.map((p, i) => (
            <p
              key={`${chapter.id}-${i}`}
              ref={(el) => {
                paraRefs.current[i] = el
              }}
              className={
                (i === paraIndex ? 'active-para' : '') + (p.kind === 'note' ? ' note-para' : '')
              }
              onClick={(e) => {
                e.stopPropagation()
                setParaIndex(i)
                saveProgress(chapter.id, i, 'read', '点击定位', true)
                if (ttsOn) {
                  stopTts()
                  window.setTimeout(() => void speakFrom(i), 50)
                }
              }}
            >
              {p.text}
            </p>
          ))
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

      <div className={`reader-topbar${menuOpen ? '' : ' hidden'}`}>
        <button
          type="button"
          className="back"
          onClick={() => {
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
              else void speakFrom(paraIndex)
            }}
          >
            <span className="mi">听</span>
            听书
          </button>
        </div>

        {(ttsOn || menuOpen) && (
          <div className="tts-bar">
            <button
              type="button"
              className="side-btn"
              onClick={() => {
                const n = Math.max(0, paraIndex - 1)
                setParaIndex(n)
                if (ttsOn) {
                  stopTts()
                  window.setTimeout(() => void speakFrom(n), 50)
                }
              }}
            >
              上段
            </button>
            <button type="button" className="tts-btn" onClick={togglePlay}>
              {!ttsOn || ttsPaused ? '▶' : '❚❚'}
            </button>
            <div className="tts-info">
              <div>{ttsOn ? (ttsPaused ? '已暂停' : '正在朗读…') : '点击播放开始朗读'}</div>
              <div className="muted">
                {chapter.title} · 第 {paraIndex + 1}/{paragraphs.length || 1} 段 · {settings.ttsRate.toFixed(1)}x
              </div>
            </div>
            <button
              type="button"
              className="side-btn"
              onClick={() => {
                const n = Math.min(Math.max(paragraphs.length - 1, 0), paraIndex + 1)
                setParaIndex(n)
                if (ttsOn) {
                  stopTts()
                  window.setTimeout(() => void speakFrom(n), 50)
                }
              }}
            >
              下段
            </button>
          </div>
        )}
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
        <div className="panel-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="panel-head">
            <span>阅读设置</span>
            <button type="button" onClick={() => setPanel(null)}>
              关闭
            </button>
          </div>
          <div className="setting-panel">
            <div className="row">
              <span>背景</span>
              <div className="theme-pills">
                {(
                  [
                    ['day', '日间'],
                    ['eye', '护眼'],
                    ['night', '夜间'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`${k}${settings.theme === k ? ' on' : ''}`}
                    onClick={() => updateSettings({ theme: k })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="row">
              <span>字号</span>
              <div className="stepper">
                <button type="button" onClick={() => updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })}>
                  A−
                </button>
                <span>{settings.fontSize}</span>
                <button type="button" onClick={() => updateSettings({ fontSize: Math.min(28, settings.fontSize + 1) })}>
                  A+
                </button>
              </div>
            </div>
            <div className="row">
              <span>语速</span>
              <div className="stepper">
                <button type="button" onClick={() => updateSettings({ ttsRate: Math.max(0.6, +(settings.ttsRate - 0.1).toFixed(1)) })}>
                  −
                </button>
                <span>{settings.ttsRate.toFixed(1)}x</span>
                <button type="button" onClick={() => updateSettings({ ttsRate: Math.min(1.8, +(settings.ttsRate + 0.1).toFixed(1)) })}>
                  +
                </button>
              </div>
            </div>
            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
              <span>在线语音 · MiniMax</span>
              <div className="voice-install-box">
                <p style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.5 }}>
                  在线语音合成（speech-2.8-turbo）。首次朗读每章需联网合成，之后缓存到本地，重复朗读不花钱。计费 ¥2/万字。
                </p>
                <p style={{ margin: 0, fontSize: 11, opacity: 0.75 }}>{engineStatus}</p>
              </div>
            </div>

            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <span>中文音色</span>
              <select
                className="voice-select"
                value={settings.ttsVoiceZh || DEFAULT_VOICE_ZH}
                onChange={(e) => updateSettings({ ttsVoiceZh: e.target.value })}
              >
                {voicesForLang('zh').map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <span>注释音色</span>
              <span style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.5 }}>
                识别*开头、[n]编号、数字编号的注释段，自动切换到此音色朗读。
              </span>
              <select
                className="voice-select"
                value={settings.ttsVoiceNote || DEFAULT_VOICE_NOTE}
                onChange={(e) => updateSettings({ ttsVoiceNote: e.target.value })}
              >
                {VOICE_CATALOG.map((v) => (
                  <option key={`note-${v.key}`} value={v.key}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
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

      {costOpen && (
        <CostModal
          chars={costChars}
          costYuan={costYuan}
          onConfirm={onConfirmCost}
          onCancel={onCancelCost}
        />
      )}

      <div className={`tts-debug-panel${debugOpen ? ' open' : ''}`}>
        <button type="button" className="tts-debug-toggle" onClick={() => setDebugOpen((v) => !v)}>
          {debugOpen ? '收起调试' : '展开调试'} ({debugLines.length})
        </button>
        {debugOpen && (
          <pre className="tts-debug-body">
            {debugLines.length === 0
              ? '暂无日志。点听书后这里会显示每一步（下载 URL / 错误 / 音量）。'
              : debugLines.slice(0, 25).map(formatDebugLine).join('\n---\n')}
          </pre>
        )}
      </div>
    </div>
  )
}

/** 语音解锁弹窗：首次朗读时要求输入密码，解密 MiniMax key */
function UnlockModal(props: {
  error: string
  loading: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
}) {
  const { error, loading, onSubmit, onCancel } = props
  const [password, setPassword] = useState('')

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!password || loading) return
    onSubmit(password)
  }

  return (
    <div className="tts-unlock-mask" onClick={onCancel}>
      <form
        className="tts-unlock-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3>语音功能解锁</h3>
        <p className="tts-unlock-desc">首次使用在线语音需输入密码，验证后自动保存，之后不再询问。</p>
        <input
          className="tts-unlock-input"
          type="password"
          autoFocus
          autoComplete="off"
          placeholder="请输入密码"
          value={password}
          disabled={loading}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <span className="tts-unlock-error">{error}</span>}
        <div className="tts-unlock-buttons">
          <button type="button" className="tts-unlock-btn cancel" onClick={onCancel} disabled={loading}>
            取消
          </button>
          <button type="submit" className="tts-unlock-btn ok" disabled={loading || !password}>
            {loading ? '解锁中…' : '解锁'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** 费用预估弹窗：合成前告知预计花费，用户确认后才继续 */
function CostModal(props: {
  chars: number
  costYuan: number
  onConfirm: () => void
  onCancel: () => void
}) {
  const { chars, costYuan, onConfirm, onCancel } = props
  const displayChars = chars >= 10_000 ? `${(chars / 10_000).toFixed(1)}万` : `${chars}`
  const displayCost = costYuan < 0.01 ? '不到 1 分' : `¥${costYuan.toFixed(2)}`
  const warn = chars >= 30_000 // ≥3 万字算超长章

  return (
    <div className="tts-unlock-mask" onClick={onCancel}>
      <div className="tts-unlock-modal" onClick={(e) => e.stopPropagation()}>
        <h3>在线语音合成</h3>
        <p className="tts-unlock-desc">
          本章需在线合成 <strong>{displayChars}</strong> 字，
          预计花费 <strong style={{ color: '#e67e22' }}>{displayCost}</strong>
          （¥2/万字）。
        </p>
        {warn && (
          <div className="tts-cost-warn">
            ⚠️ 本章超过 3 万字，可能是**章节切分异常（多章合并）**。
            如确认是意外，建议先移除书籍后重新导入，再开始朗读。
          </div>
        )}
        <p className="tts-unlock-desc" style={{ fontSize: 13, opacity: 0.75 }}>
          合成后自动缓存，重复朗读本章不再扣费。
        </p>
        <div className="tts-unlock-buttons">
          <button type="button" className="tts-unlock-btn cancel" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="tts-unlock-btn ok" onClick={onConfirm}>
            {warn ? '确认继续合成' : '确认合成'}
          </button>
        </div>
      </div>
    </div>
  )
}
