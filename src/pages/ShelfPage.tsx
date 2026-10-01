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
  const importAudioPackage = useAppStore((s) => s.importAudioPackage)
  const fileRef = useRef<HTMLInputElement>(null)
  const pkgRef = useRef<HTMLInputElement>(null)
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
        await yieldToMain()
        const buf = await file.arrayBuffer()
        const parsed = await parseEpub(buf, file.name, (p) => {
          if (p.phase === 'unzip') setProgress('解压 EPUB…')
          else if (p.total > 0) setProgress(`解析章节 ${Math.min(p.current + 1, p.total)}/${p.total}`)
        })
        importParsedBook(parsed)
        return
      }
      if (name.endsWith('.txt') || file.type.startsWith('text/')) {
        await yieldToMain()
        setProgress('解析 TXT…')
        const text = await file.text()
        importTextBook(text, file.name)
        return
      }
      setError('暂仅支持 TXT、EPUB 格式')
    } catch (e) {
      const msg = e instanceof Error ? e.message : '导入失败，请换一个文件试试'
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

  const onPickPackage = async (file: File) => {
    setError('')
    setBusy(true)
    setProgress('导入音频包…')
    try {
      await yieldToMain()
      setProgress('解包并解析 manifest…')
      const r = await importAudioPackage(file)
      setProgress('')
      window.alert(
        r.isNew
          ? `导入成功：《${file.name.replace(/\.langyue\.zip$/i, '') || '书籍'}》已入库，含 ${r.totalCount} 章音频。`
          : `合并成功：本次 ${r.mergedCount} 章，本书累计 ${r.totalCount} 章有音频。`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '音频包导入失败')
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <div>
      <header className="page-header">
        <h1>书架</h1>
        <p className="sub">共 {books.length} 本 · 支持 TXT / EPUB / 音频包</p>
      </header>

      <div className="shelf-toolbar">
        <button
          className="btn-primary"
          type="button"
          disabled={busy}
          onClick={() => pkgRef.current?.click()}
        >
          {busy ? progress || '导入中…' : '+ 导入音频包'}
        </button>
        <button className="btn-ghost" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          TXT / EPUB
        </button>
        <input
          ref={pkgRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onPickPackage(f)
            e.target.value = ''
          }}
        />
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

      {busy && progress && <div className="import-banner">导入中，请稍候…</div>}

      {showImportHint && !busy && (
        <div className="import-banner">
          导入 PC 端导出的音频包（.langyue.zip）即可听书；或导入 TXT / EPUB 纯文本阅读。阅读位置会自动记录。
        </div>
      )}

      {books.length === 0 ? (
        <div className="empty-state">书架空空如也，导入音频包或电子书开始吧</div>
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
