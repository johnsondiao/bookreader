import { useCallback, useRef, useState } from 'react'
import { BookCard } from '../components/BookCard'
import { useAppStore } from '../store/useAppStore'
import { parseEpub } from '../utils/epubParser'
import { formatBytes, type ImportProgress } from '../utils/audioPackage'
import {
  isAllFilesAccessGranted,
  requestAllFilesAccess,
  type InboxCandidate,
} from '../utils/audioPackageStore'

function yieldToMain() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0))
  })
}

const PHASE_LABEL: Record<ImportProgress['phase'], string> = {
  read: '读取压缩包',
  manifest: '解析 manifest',
  scan: '扫描文件夹',
  unzip: '解压音频',
  write: '写入音频',
  move: '接管目录',
}

interface LogLine {
  at: number
  text: string
}

export function ShelfPage() {
  const books = useAppStore((s) => s.books)
  const showImportHint = useAppStore((s) => s.showImportHint)
  const openBook = useAppStore((s) => s.openBook)
  const removeBook = useAppStore((s) => s.removeBook)
  const importTextBook = useAppStore((s) => s.importTextBook)
  const importParsedBook = useAppStore((s) => s.importParsedBook)
  const importAudioPackage = useAppStore((s) => s.importAudioPackage)
  const scanInboxFolders = useAppStore((s) => s.scanInboxFolders)
  const importFromFolder = useAppStore((s) => s.importFromFolder)
  const prepareInbox = useAppStore((s) => s.prepareInbox)

  const fileRef = useRef<HTMLInputElement>(null)
  const pkgRef = useRef<HTMLInputElement>(null)
  const startedAtRef = useRef(0)
  const lastLogKeyRef = useRef('')

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [showLog, setShowLog] = useState(false)
  const [error, setError] = useState('')

  const [folderOpen, setFolderOpen] = useState(false)
  const [inboxPath, setInboxPath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [candidates, setCandidates] = useState<InboxCandidate[] | null>(null)
  const [importingDir, setImportingDir] = useState<string | null>(null)

  /** 重置一次导入会话的进度与日志 */
  const beginSession = useCallback((title: string) => {
    startedAtRef.current = Date.now()
    lastLogKeyRef.current = ''
    setLogs([{ at: 0, text: title }])
    setProgress(null)
    setError('')
    setBusy(true)
  }, [])

  /** 进度回调：写入进度条 + 节流记录过程日志 */
  const onProgress = useCallback((p: ImportProgress) => {
    setProgress(p)
    const bucket = p.total > 0 ? Math.floor((p.current / p.total) * 20) : 0
    const key = `${p.phase}:${bucket}`
    if (key !== lastLogKeyRef.current) {
      lastLogKeyRef.current = key
      setLogs((prev) => [...prev.slice(-299), { at: Date.now() - startedAtRef.current, text: p.detail }])
    }
  }, [])

  const finishSession = useCallback((note: string) => {
    setLogs((prev) => [...prev.slice(-299), { at: Date.now() - startedAtRef.current, text: note }])
    setBusy(false)
    setProgress(null)
  }, [])

  const onPickFile = async (file: File) => {
    setError('')
    beginSession(`导入《${file.name}》`)
    try {
      const name = file.name.toLowerCase()
      if (name.endsWith('.epub')) {
        await yieldToMain()
        const buf = await file.arrayBuffer()
        const parsed = await parseEpub(buf, file.name, (p) => {
          if (p.phase === 'unzip') onProgress({ phase: 'unzip', current: 0, total: 0, detail: '解压 EPUB…' })
          else if (p.total > 0)
            onProgress({
              phase: 'manifest',
              current: p.current + 1,
              total: p.total,
              detail: `解析章节 ${Math.min(p.current + 1, p.total)} / ${p.total}`,
            })
        })
        importParsedBook(parsed)
        finishSession(`完成：EPUB 已入库`)
        return
      }
      if (name.endsWith('.txt') || file.type.startsWith('text/')) {
        await yieldToMain()
        onProgress({ phase: 'manifest', current: 0, total: 0, detail: '解析 TXT…' })
        const text = await file.text()
        importTextBook(text, file.name)
        finishSession('完成：TXT 已入库')
        return
      }
      setError('暂仅支持 TXT、EPUB 格式')
      finishSession('失败：格式不支持')
    } catch (e) {
      const msg = e instanceof Error ? e.message : '导入失败，请换一个文件试试'
      setError(/quota|exceeded|存储/i.test(msg) ? '书籍过大，存储空间不足。请删除部分书籍后再试。' : msg)
      finishSession(`失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  const onPickPackage = async (file: File) => {
    setError('')
    // 流式逐章解压：无论多大的包都不再要求用户手动解压，由 App 自动完成，
    // 全程有进度条与过程日志（见下方 import-progress / import-log 区块）。
    beginSession(`导入音频包 ${file.name}（${formatBytes(file.size)}）`)
    try {
      await yieldToMain()
      const r = await importAudioPackage(file, onProgress)
      if (r.isNew) {
        window.alert(`导入成功：已入库 ${r.totalCount} 章音频。`)
      } else {
        window.alert(`合并成功：本次 ${r.mergedCount} 章，累计 ${r.totalCount} 章有音频。`)
      }
      finishSession(`完成：${r.totalCount} 章可用`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '音频包导入失败'
      setError(msg)
      finishSession(`失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  /** 打开文件夹导入面板：准备目录 + 自动扫一次 */
  const openFolderPanel = async () => {
    setError('')
    setFolderOpen(true)
    if (candidates === null) void doScan()
  }

  const doScan = async () => {
    setError('')
    setScanning(true)
    setCandidates(null)
    startedAtRef.current = Date.now()
    lastLogKeyRef.current = ''
    setLogs([{ at: 0, text: '扫描待导入文件夹…' }])
    try {
      const granted = await isAllFilesAccessGranted()
      if (!granted) {
        const r = await requestAllFilesAccess()
        if (!r.granted) {
          const path = await prepareInbox()
          setInboxPath(path)
          setError('需要「所有文件访问权限」才能读取解压好的文件夹，请在系统设置里授权后重试。')
          setScanning(false)
          return
        }
      }
      const path = await prepareInbox()
      setInboxPath(path)
      const list = await scanInboxFolders(onProgress)
      setCandidates(list)
      setLogs((prev) => [
        ...prev,
        {
          at: Date.now() - startedAtRef.current,
          text: list.length ? `扫描完成：发现 ${list.length} 个音频包` : '未发现音频包',
        },
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : '扫描失败')
    } finally {
      setScanning(false)
      setProgress(null)
    }
  }

  const onImportCandidate = async (cand: InboxCandidate) => {
    setError('')
    setImportingDir(cand.dirName)
    beginSession(`导入《${cand.manifest.book.title}》（${cand.expectedChapterCount} 章）`)
    try {
      const r = await importFromFolder(cand, onProgress)
      finishSession(
        r.transferMode === 'copy'
          ? `完成：${r.totalCount} 章可用（逐文件复制）`
          : `完成：${r.totalCount} 章可用（目录已原地接管，未复制数据）`,
      )
      window.alert(
        `导入成功：《${cand.manifest.book.title}》\n` +
          `共 ${r.totalCount} 章音频${r.transferMode === 'copy' ? '（复制模式）' : '，秒级完成'}。`,
      )
      await doScan()
    } catch (e) {
      const msg = e instanceof Error ? e.message : '文件夹导入失败'
      setError(msg)
      finishSession(`失败：${msg}`)
    } finally {
      setImportingDir(null)
      setBusy(false)
    }
  }

  const copyInboxPath = async () => {
    try {
      await navigator.clipboard.writeText(inboxPath)
      window.alert('路径已复制')
    } catch {
      window.alert(`请手动复制：\n${inboxPath}`)
    }
  }

  const pct =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : null
  const indeterminate = progress !== null && (progress.total <= 0 || pct === null)

  return (
    <div>
      <header className="page-header">
        <h1>书架</h1>
        <p className="sub">共 {books.length} 本 · 支持 TXT / EPUB / 音频包</p>
      </header>

      <div className="shelf-toolbar">
        <button className="btn-primary" type="button" disabled={busy} onClick={() => pkgRef.current?.click()}>
          + 导入音频包
        </button>
        <button className="btn-ghost" type="button" disabled={busy} onClick={() => void openFolderPanel()}>
          文件夹导入
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

      {/* 进度条：阶段 + 百分比 + 明细，让用户随时知道卡在哪一步 */}
      {busy && (
        <div className="import-progress">
          <div className="import-progress-head">
            <span>{progress ? PHASE_LABEL[progress.phase] : '准备中'}</span>
            <span className="muted">{pct === null ? '进行中…' : `${pct}%`}</span>
          </div>
          <div className={`import-progress-track${indeterminate ? ' indeterminate' : ''}`}>
            <div className="import-progress-fill" style={{ width: pct === null ? '100%' : `${pct}%` }} />
          </div>
          {progress && <div className="import-progress-detail">{progress.detail}</div>}
        </div>
      )}

      {(logs.length > 0 || busy) && (
        <div className="import-log">
          <button className="import-log-toggle" type="button" onClick={() => setShowLog((v) => !v)}>
            {showLog ? '收起过程日志' : `过程日志（${logs.length} 条）`}
          </button>
          {showLog && (
            <div className="import-log-body">
              {logs.map((l, i) => (
                <div className="import-log-line" key={i}>
                  <span className="muted">{(l.at / 1000).toFixed(1)}s</span> {l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 文件夹导入面板 */}
      {folderOpen && (
        <div className="folder-import">
          <div className="folder-import-head">
            <strong>文件夹导入（备用方式）</strong>
            <button className="link-btn" type="button" onClick={() => setFolderOpen(false)}>
              收起
            </button>
          </div>
          <p className="folder-import-tip">
            一般不需要用这个：直接点「+ 导入音频包」选 <code>.langyue.zip</code>，App 会自动流式解压并导入，全程有进度。
            仅当你已经在别处解压好了文件夹（里面应含 <code>manifest.json</code>、<code>book/</code>、<code>audio/</code>），
            想免去再次解压、省一份空间时，才把它整体放进下面这个目录，然后点「重新扫描」——App 会原地接管，不复制数据。
          </p>
          <div className="folder-import-path">
            <code>{inboxPath || '读取中…'}</code>
            <button className="link-btn" type="button" onClick={() => void copyInboxPath()}>
              复制路径
            </button>
          </div>
          <div className="folder-import-actions">
            <button className="btn-ghost" type="button" disabled={scanning || busy} onClick={() => void doScan()}>
              {scanning ? '扫描中…' : '重新扫描'}
            </button>
          </div>

          {scanning && !candidates && <div className="folder-import-empty">正在扫描…</div>}

          {candidates && candidates.length === 0 && (
            <div className="folder-import-empty">
              这个目录里还没有可导入的音频包。把解压好的文件夹放进去后点「重新扫描」即可。
            </div>
          )}

          {candidates && candidates.length > 0 && (
            <div className="inbox-list">
              {candidates.map((c) => {
                const missing = c.expectedChapterCount - c.audioFileCount
                return (
                  <div className="inbox-item" key={c.dirName}>
                    <div className="inbox-item-main">
                      <div className="inbox-item-title">《{c.manifest.book.title}》</div>
                      <div className="inbox-item-meta">
                        {c.manifest.book.author ? `${c.manifest.book.author} · ` : ''}
                        {c.expectedChapterCount} 章 · {c.audioFileCount} 个音频文件
                        {c.sizeBytes > 0 ? ` · ${formatBytes(c.sizeBytes)}` : ''}
                      </div>
                      {missing > 0 && (
                        <div className="inbox-item-warn">有 {missing} 章没有音频文件（只能纯文本阅读）</div>
                      )}
                      <div className="inbox-item-dir">目录：{c.dirName}</div>
                    </div>
                    <button
                      className="btn-primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void onImportCandidate(c)}
                    >
                      {importingDir === c.dirName ? '导入中…' : '导入'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {showImportHint && !busy && (
        <div className="import-banner">
          导入 PC 端导出的音频包（.langyue.zip）即可听书，App 会自动解压导入并显示进度；阅读位置会自动记录。
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
