import { useRef, useState } from 'react'
import { BookCard } from '../components/BookCard'
import { useAppStore } from '../store/useAppStore'
import { parseEpub } from '../utils/epubParser'

function yieldToMain() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0))
  })
}

export function ShelfPage() {
  const books = useAppStore((s) => s.books)
  const showImportHint = useAppStore((s) => s.showImportHint)
  const openBook = useAppStore((s) => s.openBook)
  const removeBook = useAppStore((s) => s.removeBook)
  const importTextBook = useAppStore((s) => s.importTextBook)
  const importParsedBook = useAppStore((s) => s.importParsedBook)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  const onPickFile = async (file: File) => {
    setError('')
    setBusy(true)
    setProgress('读取文件…')
    try {
      const name = file.name.toLowerCase()
      if (name.endsWith('.epub')) {
        // 大文件先让 UI 画出「导入中」再开始重活
        await yieldToMain()
        const buf = await file.arrayBuffer()
        const parsed = await parseEpub(buf, file.name, (p) => {
          if (p.phase === 'unzip') {
            setProgress('解压 EPUB…')
          } else if (p.total > 0) {
            setProgress(`解析章节 ${Math.min(p.current + 1, p.total)}/${p.total}`)
          }
        })
        setProgress('保存到书架…')
        await yieldToMain()
        const id = importParsedBook(parsed)
        // 等一帧再打开阅读器，避免解析刚结束立刻渲染大章节
        await yieldToMain()
        openBook(id)
        return
      }
      if (name.endsWith('.txt') || file.type.startsWith('text/')) {
        await yieldToMain()
        setProgress('解析 TXT…')
        const text = await file.text()
        const id = importTextBook(text, file.name)
        await yieldToMain()
        openBook(id)
        return
      }
      setError('暂仅支持 TXT、EPUB 格式')
    } catch (e) {
      const msg = e instanceof Error ? e.message : '导入失败，请换一个文件试试'
      // localStorage 配额问题的友好提示（旧数据迁移后一般不会再出现）
      if (/quota|exceeded|存储/i.test(msg)) {
        setError('书籍过大，存储空间不足。请删除部分书籍后再试。')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
      setProgress('')
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
          {busy ? progress || '导入中…' : '+ 导入电子书'}
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

      {busy && progress && (
        <div className="import-banner">大书解析需要一点时间，请稍候，界面不会卡住…</div>
      )}

      {showImportHint && !busy && (
        <div className="import-banner">
          可导入手机上的 TXT 或 EPUB；朗读位置与阅读进度会自动记录。
        </div>
      )}

      {books.length === 0 ? (
        <div className="empty-state">书架空空如也，导入一本电子书开始吧</div>
      ) : (
        <div className="shelf-grid">
          {books.map((b) => (
            <BookCard key={b.id} book={b} onOpen={openBook} onRemove={removeBook} />
          ))}
        </div>
      )}
    </div>
  )
}
