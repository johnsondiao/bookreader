import { useEffect, useMemo, useRef, useState } from 'react'
import type { Book, TocEntry, TocReadStatus } from '../types'
import { useAppStore } from '../store/useAppStore'
import { costOfChars, formatCharCount, formatCostEstimate } from '../utils/charStats'

function statusOf(
  entry: TocEntry,
  book: Book,
  currentChapterId: string,
): TocReadStatus {
  if (!entry.chapterId) return 'unread'
  if (entry.chapterId === currentChapterId) return 'reading'
  // 仅标记实际打开/读过的章节，不因当前位置把前面章节一律算已读
  if ((book.readChapterIds || []).includes(entry.chapterId)) return 'read'
  return 'unread'
}

interface TocPanelProps {
  book: Book
  currentChapterId: string
  onJump: (chapterId: string) => void
  onClose: () => void
}

export function TocPanel({ book, currentChapterId, onJump, onClose }: TocPanelProps) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const currentRef = useRef<HTMLButtonElement>(null)
  const ensureBookCharStats = useAppStore((s) => s.ensureBookCharStats)

  // 兜底：旧书还没统计过字数时补一下（书架挂载时已经会补全部）
  useEffect(() => {
    if (typeof book.totalChars !== 'number') ensureBookCharStats(book.id)
  }, [book.id, book.totalChars, ensureBookCharStats])

  /** chapterId → 计费字数；没统计过的章不入表，宁可不显示也不在渲染里全文重扫 */
  const charByChapterId = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of book.chapters) {
      if (typeof c.charCount === 'number') m.set(c.id, c.charCount)
    }
    return m
  }, [book.chapters])

  const toc = useMemo(() => {
    if (book.toc?.length) return book.toc
    return book.chapters.map((c, i) => ({
      id: `toc-${i}`,
      title: c.title,
      level: 0,
      chapterId: c.id,
      href: c.href || '',
    }))
  }, [book.toc, book.chapters])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return toc
    return toc.filter((t) => t.title.toLowerCase().includes(q))
  }, [toc, query])

  const visible = useMemo(() => {
    if (query.trim()) return filtered
    const hiddenLevels: number[] = []
    const out: TocEntry[] = []
    for (const entry of filtered) {
      while (hiddenLevels.length && hiddenLevels[hiddenLevels.length - 1] >= entry.level) {
        hiddenLevels.pop()
      }
      if (hiddenLevels.length) continue
      out.push(entry)
      if (collapsed[entry.id]) hiddenLevels.push(entry.level)
    }
    return out
  }, [filtered, collapsed, query])

  const readCount = useMemo(() => {
    const set = new Set(book.readChapterIds || [])
    // 当前章算在读，统计里仍计入「到过」
    if (currentChapterId) set.add(currentChapterId)
    return book.chapters.filter((c) => set.has(c.id)).length
  }, [book.readChapterIds, book.chapters, currentChapterId])

  const hasChildren = (id: string, level: number) => {
    const i = toc.findIndex((t) => t.id === id)
    if (i < 0 || i + 1 >= toc.length) return false
    return toc[i + 1].level > level
  }

  useEffect(() => {
    let raf = 0
    raf = requestAnimationFrame(() => {
      currentRef.current?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(raf)
  }, [currentChapterId])

  const jumpCurrent = () => {
    currentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const expandAll = () => setCollapsed({})
  const collapseAll = () => {
    const next: Record<string, boolean> = {}
    toc.forEach((t) => {
      if (hasChildren(t.id, t.level)) next[t.id] = true
    })
    setCollapsed(next)
  }

  return (
    <div className="panel-sheet toc-panel" onClick={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <span>目录 · {toc.length} 项</span>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="toc-toolbar">
        <input
          className="toc-search"
          type="search"
          placeholder="搜索章节…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="toc-toolbar-actions">
          <button type="button" onClick={jumpCurrent}>
            定位当前
          </button>
          <button type="button" onClick={expandAll}>
            全部展开
          </button>
          <button type="button" onClick={collapseAll}>
            全部折叠
          </button>
        </div>
      </div>

      <div className="toc-legend">
        <span className="toc-dot read" />
        已读
        <span className="toc-dot reading" />
        在读
        <span className="toc-dot unread" />
        未读
        <span className="toc-stats">
          已读 {readCount}/{book.chapters.length} 章 · {book.progressPercent}%
        </span>
      </div>

      {typeof book.totalChars === 'number' && (
        <div className="toc-total">
          全书 {formatCharCount(book.totalChars)} · 全部朗读约需{' '}
          <strong>{formatCostEstimate(costOfChars(book.totalChars))}</strong>
        </div>
      )}

      <div className="panel-body toc-body">
        {visible.length === 0 ? (
          <div className="toc-empty">没有匹配的章节</div>
        ) : (
          visible.map((entry) => {
            const st = statusOf(entry, book, currentChapterId)
            const kids = !query.trim() && hasChildren(entry.id, entry.level)
            const isCurrent = entry.chapterId === currentChapterId
            const disabled = !entry.chapterId
            const chars = entry.chapterId ? charByChapterId.get(entry.chapterId) : undefined
            return (
              <button
                key={entry.id}
                type="button"
                ref={isCurrent ? currentRef : undefined}
                className={`toc-row status-${st}${isCurrent ? ' current' : ''}${disabled ? ' disabled' : ''}`}
                style={{ paddingLeft: 10 + entry.level * 14 }}
                disabled={disabled && !kids}
                onClick={() => {
                  if (entry.chapterId) {
                    onJump(entry.chapterId)
                    return
                  }
                  if (kids) {
                    setCollapsed((c) => ({ ...c, [entry.id]: !c[entry.id] }))
                  }
                }}
              >
                <span
                  className={`toc-twist${kids ? '' : ' spacer'}`}
                  onClick={(e) => {
                    if (!kids) return
                    e.stopPropagation()
                    setCollapsed((c) => ({ ...c, [entry.id]: !c[entry.id] }))
                  }}
                >
                  {kids ? (collapsed[entry.id] ? '▸' : '▾') : '·'}
                </span>
                <span className={`toc-dot ${st}`} />
                <span className="toc-title">{entry.title}</span>
                {typeof chars === 'number' && (
                  <span className="toc-chars">
                    {formatCharCount(chars)} · {formatCostEstimate(costOfChars(chars))}
                  </span>
                )}
                {st === 'read' && <span className="toc-badge">已读</span>}
                {st === 'reading' && <span className="toc-badge reading">在读</span>}
                {disabled && <span className="toc-badge muted">无正文</span>}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
