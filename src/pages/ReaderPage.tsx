import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TocPanel } from '../components/TocPanel'
import { useAppStore } from '../store/useAppStore'
import { splitParagraphs } from '../utils/chapterParser'
import { createTtsController } from '../utils/tts'

type Panel = null | 'toc' | 'settings'

const INITIAL_VISIBLE = 40
const LOAD_MORE = 40
const TINY_CHAPTER = 40

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
  const contentRef = useRef<HTMLDivElement>(null)
  const paraRefs = useRef<(HTMLParagraphElement | null)[]>([])
  const ttsRef = useRef(createTtsController())
  const speakingRef = useRef(false)
  const touchRef = useRef<{ x: number; y: number } | null>(null)
  const chapterIdRef = useRef(chapterId)

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

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2200)
  }

  // #region agent log
  useEffect(() => {
    void ttsRef.current.probe().then((info) => {
      if (info.native && info.chineseOk === false) {
        showToast('缺少中文语音包，可在设置中安装')
      }
    })
  }, [book?.id])
  // #endregion

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
      speakingRef.current = true
      setTtsOn(true)
      setTtsPaused(false)
      setMenuOpen(true)

      for (let i = startIndex; i < paragraphs.length; i++) {
        if (!speakingRef.current) break
        setParaIndex(i)
        scrollToPara(i)
        saveProgress(chapter.id, i, 'tts', '朗读进度', true)

        try {
          await ttsRef.current.speak(paragraphs[i], settings.ttsRate)
        } catch (err) {
          showToast(err instanceof Error ? err.message : '当前环境不支持语音朗读')
          speakingRef.current = false
          setTtsOn(false)
          return
        }

        while (speakingRef.current && ttsRef.current.getStatus() === 'paused') {
          await new Promise((r) => setTimeout(r, 200))
        }
      }

      if (speakingRef.current) {
        const idx = book.chapters.findIndex((c) => c.id === chapter.id)
        if (idx >= 0 && idx < book.chapters.length - 1) {
          const next = book.chapters[idx + 1]
          setChapterId(next.id)
          setParaIndex(0)
          saveProgress(next.id, 0, 'tts', '进入下一章')
          speakingRef.current = false
          setTtsOn(false)
          showToast('本章朗读完成，已进入下一章')
        } else {
          speakingRef.current = false
          setTtsOn(false)
          showToast('全书朗读完成')
        }
      }
    },
    [book, chapter, paragraphs, saveProgress, settings.ttsRate, settings.autoScroll],
  )

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
              className={i === paraIndex ? 'active-para' : undefined}
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
              {p}
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
          <button type="button" className={panel === 'settings' ? 'active' : ''} onClick={() => setPanel(panel === 'settings' ? null : 'settings')}>
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
            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <span>中文语音包</span>
              <button
                type="button"
                className="btn-primary"
                style={{ width: '100%' }}
                onClick={() => {
                  void ttsRef.current
                    .openLanguageInstall()
                    .then(() => {
                      showToast('请安装「中文（简体）」后返回重试朗读')
                      return ttsRef.current.probe()
                    })
                    .catch((e) => showToast(e instanceof Error ? e.message : '打开安装页失败'))
                }}
              >
                安装 / 管理语音数据
              </button>
              <span style={{ fontSize: 11, opacity: 0.65, lineHeight: 1.4 }}>
                若提示语言不支持，需在系统中安装中文文字转语音（TTS）数据包。
              </span>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
