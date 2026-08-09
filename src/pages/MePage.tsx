import { useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useAppStore } from '../store/useAppStore'
import {
  listAudioFiles,
  deleteAudioFile,
  getAudioPlayUrl,
  getAudioAbsolutePath,
  isAudioFsAvailable,
  getLastFsError,
  clearLastFsError,
} from '../utils/audioFileStore'
import { getTodayCostYuan, formatCost } from '../utils/costTracker'
import type { AudioFileRecord } from '../types'

function fmtSize(bytes: number): string {
  if (bytes == null) return '—'
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`
}
function fmtTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function MePage() {
  const books = useAppStore((s) => s.books)
  const snapshots = useAppStore((s) => s.snapshots)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const removeBook = useAppStore((s) => s.removeBook)

  const reading = books.filter((b) => b.progressPercent > 0).length
  const ttsCount = snapshots.filter((s) => s.source === 'tts').length

  /* ===== 已合成音频列表 ===== */
  const [list, setList] = useState<AudioFileRecord[]>([])
  const [fsOk, setFsOk] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [selectedBook, setSelectedBook] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  async function reload() {
    setLoading(true)
    setErrMsg(null)
    clearLastFsError()
    try {
      const ok = await isAudioFsAvailable()
      setFsOk(ok)
      if (!ok) {
        // 原生环境下如果不可用，把底层错误掏出来展示
        if (Capacitor.isNativePlatform()) {
          const e = getLastFsError()
          setErrMsg(e || '初始化失败（未捕获到具体错误）')
        }
        setList([])
      } else {
        setList(await listAudioFiles())
      }
    } catch (err) {
      setErrMsg((err as Error)?.message || String(err))
      setList([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void reload()
  }, [])

  // 全局 audio：切歌时复用同一个 <audio>，避免多条同时响
  useEffect(() => {
    const a = typeof Audio !== 'undefined' ? new Audio() : null
    if (!a) return
    audioRef.current = a
    a.addEventListener('ended', () => setPlayingId(null))
    return () => {
      try {
        a.pause()
      } catch { /* ignore */ }
      a.src = ''
    }
  }, [])

  const [todayCostYuan, setTodayCostYuan] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    void getTodayCostYuan().then((v) => {
      if (!cancelled) setTodayCostYuan(v)
    })
    const t = setInterval(() => {
      void getTodayCostYuan().then((v) => { if (!cancelled) setTodayCostYuan(v) })
    }, 30000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const totalSize = useMemo(() => list.reduce((s, x) => s + (x.sizeBytes || 0), 0), [list])

  function promptDailyBudget() {
    const cur = settings.dailyBudgetYuan ?? 0
    const input = window.prompt(
      '设置每日 TTS 预算上限（元），0 表示不限制。\n\n达到上限后会停止合成，避免超支。',
      cur === 0 ? '' : String(cur),
    )
    if (input == null) return
    const trimmed = input.trim()
    if (trimmed === '') {
      updateSettings({ dailyBudgetYuan: 0 })
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) {
      alert('请输入 0 或正数。')
      return
    }
    updateSettings({ dailyBudgetYuan: Number(n.toFixed(2)) })
  }

  // 按 bookId 分组（书名以书架上的原始标题为准，rebuild 文件名变形时不影响分组）
  const bookGroups = useMemo(() => {
    const bookTitleMap = new Map<string, string>()
    for (const b of books) bookTitleMap.set(b.id, b.title)
    const map = new Map<string, { bookId: string; bookTitle: string; items: AudioFileRecord[]; totalSize: number }>()
    for (const it of list) {
      const bid = it.bookId
      const rawTitle = bookTitleMap.get(bid) || it.bookTitle
      const g = map.get(bid) || { bookId: bid, bookTitle: rawTitle, items: [], totalSize: 0 }
      g.items.push(it)
      g.totalSize += it.sizeBytes || 0
      map.set(bid, g)
    }
    return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length)
  }, [list, books])

  const currentBookItems = useMemo(
    () => (selectedBook ? list.filter((x) => {
      const bid = bookGroups.find((g) => g.bookTitle === selectedBook)?.bookId
      return bid ? x.bookId === bid : x.bookTitle === selectedBook
    }) : []),
    [list, selectedBook, bookGroups],
  )

  async function onPlay(item: AudioFileRecord) {
    const audio = audioRef.current
    if (!audio) return
    // 正在播同一条 → 暂停
    if (playingId === item.id) {
      audio.pause()
      setPlayingId(null)
      return
    }
    try {
      const url = await getAudioPlayUrl(item.id)
      if (!url) {
        alert('找不到该音频文件，可能已被从文件管理器中删除。')
        return
      }
      audio.src = url
      audio.playbackRate = settings.ttsRate
      await audio.play()
      setPlayingId(item.id)
    } catch (err) {
      console.warn('[MePage] 播放失败', err)
      alert('播放失败：' + ((err as Error)?.message || String(err)))
    }
  }
  async function onDelete(item: AudioFileRecord) {
    if (!confirm(`确认删除该音频？\n《${item.bookTitle}》· ${item.chapterTitle}\n（将同时删除物理 mp3 文件）`)) return
    try {
      if (playingId === item.id) {
        audioRef.current?.pause()
        if (audioRef.current) audioRef.current.src = ''
        setPlayingId(null)
      }
      await deleteAudioFile(item.id)
      setList((prev) => prev.filter((x) => x.id !== item.id))
    } catch (err) {
      alert('删除失败：' + ((err as Error)?.message || String(err)))
    }
  }
  async function onShowPath(item: AudioFileRecord) {
    const p = await getAudioAbsolutePath(item.id)
    alert(p || '（暂无路径信息）')
  }

  return (
    <div>
      <header className="page-header">
        <h1>我的</h1>
        <p className="sub">朗阅 · 本地电子书朗读</p>
      </header>

      <div className="me-card">
        <div className="name">本地读者</div>
        <div className="me-stats">
          <div>
            <div className="n">{books.length}</div>
            <div className="l">藏书</div>
          </div>
          <div>
            <div className="n">{reading}</div>
            <div className="l">在读</div>
          </div>
          <div>
            <div className="n">{ttsCount}</div>
            <div className="l">朗读记录</div>
          </div>
          <div>
            <div className="n">{formatCost(todayCostYuan)}</div>
            <div className="l">今日花费</div>
          </div>
        </div>
      </div>

      <div className="setting-list">
        <div className="setting-row">
          <span>朗读语速</span>
          <div className="stepper">
            <button type="button" onClick={() => updateSettings({ ttsRate: Math.max(0.6, +(settings.ttsRate - 0.1).toFixed(1)) })}>
              −
            </button>
            <span className="val">{settings.ttsRate.toFixed(1)}x</span>
            <button type="button" onClick={() => updateSettings({ ttsRate: Math.min(1.8, +(settings.ttsRate + 0.1).toFixed(1)) })}>
              +
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span>默认字体</span>
          <div className="stepper">
            <button type="button" onClick={() => updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })}>
              A−
            </button>
            <span className="val">{settings.fontSize}</span>
            <button type="button" onClick={() => updateSettings({ fontSize: Math.min(28, settings.fontSize + 1) })}>
              A+
            </button>
          </div>
        </div>
        <button
          type="button"
          className="setting-row"
          onClick={() => {
            const themes = ['day', 'eye', 'night'] as const
            const i = themes.indexOf(settings.theme)
            updateSettings({ theme: themes[(i + 1) % themes.length] })
          }}
        >
          <span>阅读主题</span>
          <span className="val">{settings.theme === 'day' ? '日间' : settings.theme === 'eye' ? '护眼' : '夜间'}</span>
        </button>
        <button type="button" className="setting-row" onClick={promptDailyBudget}>
          <span>每日 TTS 预算上限</span>
          <span className="val">
            {(settings.dailyBudgetYuan ?? 0) > 0
              ? `¥${(settings.dailyBudgetYuan ?? 0).toFixed(2)}`
              : '不限制'}
          </span>
        </button>
      </div>

      {/* ======= 已合成音频 ======= */}
      <div className="setting-list" style={{ marginTop: 16 }}>
        {selectedBook ? (
          /* ===== 详情页：某本书的所有音频 ===== */
          <>
            <button
              type="button"
              className="setting-row"
              onClick={() => setSelectedBook(null)}
              style={{ color: 'var(--accent)', fontSize: 14 }}
            >
              <span>← 返回音频列表</span>
            </button>
            <div className="setting-row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontWeight: 600, fontSize: 16 }}>《{selectedBook}》</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                {currentBookItems.length} 条音频 · 共 {fmtSize(currentBookItems.reduce((s, x) => s + (x.sizeBytes || 0), 0))}
              </div>
            </div>
            {currentBookItems.map((it) => {
              const playing = playingId === it.id
              return (
                <div
                  key={it.id}
                  className="setting-row"
                  style={{ display: 'block', padding: '10px 16px', gap: 8 }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {it.chapterTitle}
                      </div>
                      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <span>{it.voiceLabel}</span>
                        <span>·</span>
                        <span>{fmtSize(it.sizeBytes)}</span>
                        <span>·</span>
                        <span>{fmtTs(it.createdAt)}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <button
                        type="button"
                        className="tts-debug-toggle"
                        style={{
                          fontSize: 12, padding: '6px 12px',
                          background: playing ? 'var(--accent)' : 'transparent',
                          color: playing ? '#fff' : 'var(--accent)',
                          border: `1px solid var(--accent)`,
                        }}
                        onClick={() => void onPlay(it)}
                      >
                        {playing ? '暂停' : '播放'}
                      </button>
                      <button
                        type="button"
                        className="tts-debug-toggle"
                        title="查看保存路径"
                        style={{ fontSize: 12, padding: '6px 10px' }}
                        onClick={() => void onShowPath(it)}
                      >
                        路径
                      </button>
                      <button
                        type="button"
                        className="tts-debug-toggle"
                        title="删除音频文件"
                        style={{
                          fontSize: 12, padding: '6px 10px',
                          color: 'var(--danger, #c0392b)',
                          border: `1px solid var(--danger-border, #e2b1ac)`,
                        }}
                        onClick={() => void onDelete(it)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </>
        ) : (
          /* ===== 列表页：按书名分组 ===== */
          <>
            <div className="setting-row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>已合成音频</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                    {loading
                      ? '正在读取…'
                      : fsOk
                      ? `${list.length} 条 · 共 ${fmtSize(totalSize)} · 覆盖升级不会丢失`
                      : errMsg
                      ? `初始化失败：${errMsg}`
                      : '当前环境不支持文件系统存储（仅 Android App 下生效）'}
                  </div>
                </div>
                <button
                  type="button"
                  className="tts-debug-toggle"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => void reload()}
                >
                  刷新
                </button>
              </div>
            </div>

            {list.length === 0 && !loading && fsOk !== false && (
              <div className="setting-row" style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 16px' }}>
                还没有合成过音频。进入书籍，点击右下角「听」按钮开始朗读后，音频会自动保存到这里。
              </div>
            )}

            {bookGroups.map((g) => (
              <button
                key={g.bookId}
                type="button"
                className="setting-row"
                onClick={() => setSelectedBook(g.bookTitle)}
              >
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    《{g.bookTitle}》
                  </div>
                  <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text-muted)' }}>
                    {g.items.length} 条音频 · {fmtSize(g.totalSize)}
                  </div>
                </div>
                <span className="val" style={{ color: 'var(--accent)' }}>查看</span>
              </button>
            ))}
          </>
        )}
      </div>

      {books.length > 0 && (
        <div className="setting-list" style={{ marginTop: 16 }}>
          <div className="setting-row" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            书籍管理 · 仅从书架移除，不会删除原文件
          </div>
          {books.map((b) => (
            <button key={b.id} type="button" className="setting-row" onClick={() => {
              if (confirm(`移除「${b.title}」？\n\n已合成的音频文件会保留在「已合成音频」中不会被删除。\n仅从书架移除，不会删除原文件。`)) {
                removeBook(b.id)
              }
            }}>
              <span>移除「{b.title}」</span>
              <span className="val" style={{ color: 'var(--accent)' }}>
                移除
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
