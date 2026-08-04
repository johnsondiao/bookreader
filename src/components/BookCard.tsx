import { useState } from 'react'
import type { Book } from '../types'

function formatProgress(p: number) {
  if (p <= 0) return '未读'
  if (p >= 99.5) return '已读完'
  return `已读 ${p.toFixed(p < 10 ? 1 : 0)}%`
}

function formatTime(ts: number) {
  if (!ts) return '尚未打开'
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚读过'
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`
  if (d < 86400_000 * 7) return `${Math.floor(d / 86400_000)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

interface Props {
  book: Book
  onOpen: (id: string) => void
  onRemove?: (id: string) => void
}

export function BookCard({ book, onOpen, onRemove }: Props) {
  const [confirming, setConfirming] = useState(false)

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirming(true)
  }

  const handleConfirm = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRemove?.(book.id)
    setConfirming(false)
  }

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirming(false)
  }

  return (
    <div className="book-card">
      <button className="book-cover" onClick={() => onOpen(book.id)} type="button" style={{ background: book.coverColor }}>
        <span className="emoji">{book.coverEmoji}</span>
        <span className="cover-title">{book.title}</span>
        <div className="progress-bar">
          <i style={{ width: `${Math.min(100, book.progressPercent)}%` }} />
        </div>
        {onRemove && !confirming && (
          <button
            type="button"
            className="book-remove-btn"
            aria-label="删除书籍"
            onClick={handleRemoveClick}
          >
            ×
          </button>
        )}
        {confirming && (
          <div className="book-remove-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-text">从书架移除？</div>
            <div className="confirm-actions">
              <button type="button" className="confirm-yes" onClick={handleConfirm}>
                删除
              </button>
              <button type="button" className="confirm-no" onClick={handleCancel}>
                取消
              </button>
            </div>
          </div>
        )}
      </button>
      <div className="book-meta">
        <div className="title">{book.title}</div>
        <div className="info">
          {formatProgress(book.progressPercent)} · {formatTime(book.lastReadAt)}
        </div>
      </div>
    </div>
  )
}
