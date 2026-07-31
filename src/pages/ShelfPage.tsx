import { useRef } from 'react'
import { BookCard } from '../components/BookCard'
import { useAppStore } from '../store/useAppStore'

export function ShelfPage() {
  const books = useAppStore((s) => s.books)
  const showImportHint = useAppStore((s) => s.showImportHint)
  const openBook = useAppStore((s) => s.openBook)
  const importTextBook = useAppStore((s) => s.importTextBook)
  const fileRef = useRef<HTMLInputElement>(null)

  const onPickFile = async (file: File) => {
    const text = await file.text()
    const id = importTextBook(text, file.name)
    openBook(id)
  }

  return (
    <div>
      <header className="page-header">
        <h1>书架</h1>
        <p className="sub">共 {books.length} 本 · 点击封面继续阅读</p>
      </header>

      <div className="shelf-toolbar">
        <button className="btn-primary" type="button" onClick={() => fileRef.current?.click()}>
          + 导入电子书
        </button>
        <button className="btn-ghost" type="button" onClick={() => fileRef.current?.click()}>
          TXT
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,text/plain"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onPickFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {showImportHint && (
        <div className="import-banner">
          已预置 3 本示例书方便预览。你也可以导入手机上的 TXT 电子书；朗读位置与阅读进度会自动记录。
        </div>
      )}

      {books.length === 0 ? (
        <div className="empty-state">书架空空如也，导入一本电子书开始吧</div>
      ) : (
        <div className="shelf-grid">
          {books.map((b) => (
            <BookCard key={b.id} book={b} onOpen={openBook} />
          ))}
        </div>
      )}
    </div>
  )
}
