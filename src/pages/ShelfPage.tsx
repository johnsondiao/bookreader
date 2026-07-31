import { useRef, useState } from 'react'
import { BookCard } from '../components/BookCard'
import { useAppStore } from '../store/useAppStore'
import { parseEpub } from '../utils/epubParser'

export function ShelfPage() {
  const books = useAppStore((s) => s.books)
  const showImportHint = useAppStore((s) => s.showImportHint)
  const openBook = useAppStore((s) => s.openBook)
  const importTextBook = useAppStore((s) => s.importTextBook)
  const importParsedBook = useAppStore((s) => s.importParsedBook)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const onPickFile = async (file: File) => {
    setError('')
    setBusy(true)
    try {
      const name = file.name.toLowerCase()
      if (name.endsWith('.epub')) {
        const buf = await file.arrayBuffer()
        const parsed = await parseEpub(buf, file.name)
        const id = importParsedBook(parsed)
        openBook(id)
        return
      }
      if (name.endsWith('.txt') || file.type.startsWith('text/')) {
        const text = await file.text()
        const id = importTextBook(text, file.name)
        openBook(id)
        return
      }
      setError('暂仅支持 TXT、EPUB 格式')
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败，请换一个文件试试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <header className="page-header">
        <h1>书架</h1>
        <p className="sub">共 {books.length} 本 · 支持 TXT / EPUB</p>
      </header>

      <div className="shelf-toolbar">
        <button
          className="btn-primary"
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? '导入中…' : '+ 导入电子书'}
        </button>
        <button className="btn-ghost" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          TXT / EPUB
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.epub,text/plain,application/epub+zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onPickFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {error && (
        <div className="import-banner" style={{ background: '#fdecea', color: '#8a1f1f' }}>
          {error}
        </div>
      )}

      {showImportHint && (
        <div className="import-banner">
          已预置 3 本示例书。可导入手机上的 TXT 或 EPUB；朗读位置与阅读进度会自动记录。
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
