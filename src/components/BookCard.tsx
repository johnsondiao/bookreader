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
}

export function BookCard({ book, onOpen }: Props) {
  return (
    <button className="book-card" onClick={() => onOpen(book.id)} type="button">
      <div className="book-cover" style={{ background: book.coverColor }}>
        <span className="emoji">{book.coverEmoji}</span>
        <span className="cover-title">{book.title}</span>
        <div className="progress-bar">
          <i style={{ width: `${Math.min(100, book.progressPercent)}%` }} />
        </div>
      </div>
      <div className="book-meta">
        <div className="title">{book.title}</div>
        <div className="info">
          {formatProgress(book.progressPercent)} · {formatTime(book.lastReadAt)}
        </div>
      </div>
    </button>
  )
}
