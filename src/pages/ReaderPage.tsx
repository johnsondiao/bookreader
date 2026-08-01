import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { splitParagraphs } from '../utils/chapterParser'
import { createTtsController } from '../utils/tts'

type Panel = null | 'toc' | 'settings'

const INITIAL_VISIBLE = 40
const LOAD_MORE = 40

function fmt(n: number) {
  return n.toLocaleString('zh-CN')
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
  const [mountedAt, setMountedAt] = useState(() => performance.now())
  const [scrollLoads, setScrollLoads] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const paraRefs = useRef<(HTMLParagraphElement | null)[]>([])
  const ttsRef = useRef(createTtsController())
  const speakingRef = useRef(false)

  const chapter = useMemo(
    () => book?.chapters.find((c) => c.id === chapterId) ?? book?.chapters[0],
    [book, chapterId],
  )

  const chapterIndex = useMemo(() => {
    if (!book || !chapter) return 0
    const i = book.chapters.findIndex((c) => c.id === chapter.id)
    return i >= 0 ? i : 0
  }, [book, chapter])

  const { paragraphs, splitMs } = useMemo(() => {
    if (!chapter) return { paragraphs: [] as string[], splitMs: 0 }
    const t0 = performance.now()
    const result = splitParagraphs(chapter.content || '')
    return { paragraphs: result, splitMs: Math.round(performance.now() - t0) }
  }, [chapter])

  const visibleParagraphs = useMemo(
    () => paragraphs.slice(0, Math.min(visibleCount, paragraphs.length)),
    [paragraphs, visibleCount],
  )

  const chapterSizes = useMemo(() => {
    if (!book) return { max: 0, avg: 0, empty: 0, totalChars: 0 }
    let max = 0
    let sum = 0
    let empty = 0
    for (const c of book.chapters) {
      const len = c.content?.length || 0
      max = Math.max(max, len)
      sum += len
      if (len < 20) empty += 1
    }
    return {
      max,
      avg: book.chapters.length ? Math.round(sum / book.chapters.length) : 0,
      empty,
      totalChars: sum,
    }
  }, [book])

  // 进入阅读器时恢复进度
  useEffect(() => {
    if (!book) return
    setChapterId(book.chapterId || book.chapters[0]?.id || '')
    setParaIndex(book.paragraphIndex || 0)
    setVisibleCount(INITIAL_VISIBLE)
    setMountedAt(performance.now())
    setScrollLoads(0)
    setMenuOpen(true)
  }, [book?.id])

  // 切章时重置窗口渲染
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE)
    setMountedAt(performance.now())
    setScrollLoads(0)
    contentRef.current?.scrollTo({ top: 0 })
  }, [chapter?.id])

  // 若当前段超出已渲染窗口，自动扩大窗口
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
    window.setTimeout(() => setToast(''), 1800)
  }

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
      setScrollLoads((n) => n + 1)
      return Math.min(paragraphs.length, v + LOAD_MORE)
    })
  }, [paragraphs.length])

  const onScrollContent = () => {
    const el = contentRef.current
    if (!el) return
    const remain = el.scrollHeight - el.scrollTop - el.clientHeight
    if (remain < 400) loadMore()
  }

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
        } catch {
          showToast('当前环境不支持语音朗读')
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
        <div className="reader-debug">
          [调试] 书籍未就绪 activeBookId={String(activeBookId)} book={book ? 'yes' : 'no'} chapter={chapter ? 'yes' : 'no'}
        </div>
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

  const stopTts = () => {
    speakingRef.current = false
    ttsRef.current.stop()
    setTtsOn(false)
    setTtsPaused(false)
    if (book) saveProgress(chapter.id, paraIndex, 'tts', '停止朗读')
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

  const jumpChapter = (cid: string) => {
    stopTts()
    setChapterId(cid)
    setParaIndex(0)
    setPanel(null)
    saveProgress(cid, 0, 'read', '切换章节')
  }

  const contentLen = chapter.content?.length || 0
  const openMs = Math.round(performance.now() - mountedAt)
  const warnHuge = paragraphs.length > 2000 || contentLen > 200_000

  return (
    <div className={`reader theme-${settings.theme}`}>
      <div className={`reader-debug${warnHuge ? ' warn' : ''}`}>
        <div>
          [调试] {book.title.slice(0, 16)} · 章 {chapterIndex + 1}/{book.chapters.length}「{chapter.title.slice(0, 20)}」
        </div>
        <div>
          本章字数 {fmt(contentLen)} · 段落 {fmt(paragraphs.length)} · 已渲染 {fmt(visibleParagraphs.length)}
          {paragraphs.length > visibleParagraphs.length ? ` (+滚动加载)` : ''}
        </div>
        <div>
          拆分 {splitMs}ms · 打开 {openMs}ms · 加载次数 {scrollLoads} · 全书字数 {fmt(chapterSizes.totalChars || 0)}
          （均章 {fmt(chapterSizes.avg)} / 最大 {fmt(chapterSizes.max)} / 空章 {chapterSizes.empty}）
        </div>
        {contentLen === 0 && <div className="err">⚠ 本章 content 为空 — 导入解析可能失败</div>}
        {paragraphs.length === 0 && contentLen > 0 && <div className="err">⚠ 有字数但段落为 0 — 拆分异常</div>}
        {warnHuge && (
          <div className="err">
            ⚠ 本章过大（段落&gt;2000 或字数&gt;20万），已改窗口渲染；若仍卡请切下一章或从目录跳过
          </div>
        )}
      </div>

      <div
        ref={contentRef}
        className="reader-content has-debug"
        style={{ fontSize: settings.fontSize, lineHeight: settings.lineHeight }}
        onClick={onTapContent}
        onScroll={onScrollContent}
      >
        <h2 className="chapter-title">{chapter.title}</h2>
        {visibleParagraphs.length === 0 ? (
          <p style={{ textIndent: 0, opacity: 0.7 }}>（本章暂无正文，可打开目录切换章节）</p>
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
          <button type="button" className="load-more-btn" onClick={(e) => { e.stopPropagation(); loadMore() }}>
            加载更多正文（{visibleParagraphs.length}/{paragraphs.length}）
          </button>
        )}
      </div>

      <div className={`reader-topbar${menuOpen ? '' : ' hidden'}`}>
        <button type="button" className="back" onClick={() => { stopTts(); closeReader() }}>
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
            <button type="button" className="side-btn" onClick={() => {
              const n = Math.max(0, paraIndex - 1)
              setParaIndex(n)
              if (ttsOn) { stopTts(); window.setTimeout(() => void speakFrom(n), 50) }
            }}>
              上段
            </button>
            <button type="button" className="tts-btn" onClick={togglePlay}>
              {!ttsOn || ttsPaused ? '▶' : '❚❚'}
            </button>
            <div className="tts-info">
              <div>{ttsOn ? (ttsPaused ? '已暂停' : '正在朗读…') : '点击播放开始朗读'}</div>
              <div className="muted">
                {chapter.title} · 第 {paraIndex + 1}/{paragraphs.length} 段 · {settings.ttsRate.toFixed(1)}x
              </div>
            </div>
            <button type="button" className="side-btn" onClick={() => {
              const n = Math.min(paragraphs.length - 1, paraIndex + 1)
              setParaIndex(n)
              if (ttsOn) { stopTts(); window.setTimeout(() => void speakFrom(n), 50) }
            }}>
              下段
            </button>
          </div>
        )}
      </div>

      {panel && <div className="overlay-mask" onClick={() => setPanel(null)} />}

      {panel === 'toc' && (
        <div className="panel-sheet">
          <div className="panel-head">
            <span>目录 · 共 {book.chapters.length} 章</span>
            <button type="button" onClick={() => setPanel(null)}>关闭</button>
          </div>
          <div className="panel-body">
            {book.chapters.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`chapter-row${c.id === chapter.id ? ' current' : ''}`}
                onClick={() => jumpChapter(c.id)}
              >
                <span style={{ opacity: 0.55, marginRight: 6, fontSize: 11 }}>{i + 1}</span>
                {c.title}
                <span style={{ marginLeft: 'auto', opacity: 0.45, fontSize: 11 }}>
                  {fmt(c.content?.length || 0)}字
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {panel === 'settings' && (
        <div className="panel-sheet">
          <div className="panel-head">
            <span>阅读设置</span>
            <button type="button" onClick={() => setPanel(null)}>关闭</button>
          </div>
          <div className="setting-panel">
            <div className="row">
              <span>背景</span>
              <div className="theme-pills">
                {([
                  ['day', '日间'],
                  ['eye', '护眼'],
                  ['night', '夜间'],
                ] as const).map(([k, label]) => (
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
                <button type="button" onClick={() => updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })}>A−</button>
                <span>{settings.fontSize}</span>
                <button type="button" onClick={() => updateSettings({ fontSize: Math.min(28, settings.fontSize + 1) })}>A+</button>
              </div>
            </div>
            <div className="row">
              <span>语速</span>
              <div className="stepper">
                <button type="button" onClick={() => updateSettings({ ttsRate: Math.max(0.6, +(settings.ttsRate - 0.1).toFixed(1)) })}>−</button>
                <span>{settings.ttsRate.toFixed(1)}x</span>
                <button type="button" onClick={() => updateSettings({ ttsRate: Math.min(1.8, +(settings.ttsRate + 0.1).toFixed(1)) })}>+</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
