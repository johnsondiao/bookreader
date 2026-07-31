import { useAppStore } from '../store/useAppStore'

function formatTime(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `今天 ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

export function HistoryPage() {
  const snapshots = useAppStore((s) => s.snapshots)
  const books = useAppStore((s) => s.books)
  const openBook = useAppStore((s) => s.openBook)
  const updateReadingProgress = useAppStore((s) => s.updateReadingProgress)
  const clearSnapshots = useAppStore((s) => s.clearSnapshots)

  const bookMap = Object.fromEntries(books.map((b) => [b.id, b]))

  return (
    <div>
      <header className="page-header">
        <h1>阅读足迹</h1>
        <p className="sub">每次阅读与朗读位置都会记录，点一下可跳转</p>
      </header>

      <div className="shelf-toolbar">
        <button className="btn-ghost" type="button" onClick={() => clearSnapshots()} disabled={!snapshots.length}>
          清空记录
        </button>
      </div>

      {snapshots.length === 0 ? (
        <div className="empty-state">还没有进度记录。打开一本书阅读或朗读后，这里会出现足迹。</div>
      ) : (
        <div className="history-list">
          {snapshots.map((s) => {
            const book = bookMap[s.bookId]
            if (!book) return null
            return (
              <button
                key={s.id}
                type="button"
                className="history-item"
                onClick={() => {
                  updateReadingProgress({
                    bookId: s.bookId,
                    chapterId: s.chapterId,
                    paragraphIndex: s.paragraphIndex,
                    charOffset: s.charOffset,
                    source: 'read',
                    note: '从足迹恢复',
                    recordSnapshot: false,
                  })
                  openBook(s.bookId)
                }}
              >
                <span className={`dot ${s.source}`} />
                <div className="body">
                  <div className="book-name">
                    {book.title}
                    <span className={`tag ${s.source}`}>{s.source === 'tts' ? '朗读' : '阅读'}</span>
                  </div>
                  <div className="detail">
                    {s.chapterTitle} · 第 {s.paragraphIndex + 1} 段 · 进度 {s.progressPercent}%
                    {s.note ? ` · ${s.note}` : ''}
                  </div>
                  <div className="time">{formatTime(s.createdAt)}</div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
