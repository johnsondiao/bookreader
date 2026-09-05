import { useEffect, useRef, useState } from 'react'
import { BookCard } from '../components/BookCard'
import { useAppStore } from '../store/useAppStore'
import { copyDiagnostic } from '../utils/diagnosticDump'
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
  const ensureBookCharStats = useAppStore((s) => s.ensureBookCharStats)
  const lastCrashReport = useAppStore((s) => s.lastCrashReport)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  // 本功能上线前导入的旧书没有字数统计：等书架画完再补齐，结果会落盘，只跑一次
  useEffect(() => {
    let cancelled = false
    void yieldToMain().then(() => {
      if (!cancelled) ensureBookCharStats()
    })
    return () => {
      cancelled = true
    }
  }, [ensureBookCharStats])

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
        setProgress('统计字数…')
        await yieldToMain()
        // 导入成功后 store 会记下 importStatsBookId，由 Home 层弹字数/费用统计
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

      {lastCrashReport && (
        <div className="import-banner" style={{ background: '#fff3cd', color: '#7a5c00' }}>
          检测到上次朗读时异常退出，诊断信息：{lastCrashReport}
          <br />
          <button
            type="button"
            style={{ marginRight: 8, textDecoration: 'underline' }}
            onClick={() => {
              void copyDiagnostic(lastCrashReport).then((ok) => {
                window.alert(ok ? '诊断日志已复制，请粘贴发给开发者' : '复制失败，请截图本页面')
              })
            }}
          >
            复制完整日志
          </button>
          <button
            type="button"
            style={{ textDecoration: 'underline' }}
            onClick={() => useAppStore.setState({ lastCrashReport: null })}
          >
            清除
          </button>
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
