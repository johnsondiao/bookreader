import { useState, useEffect } from 'react'
import {
  statsByDay,
  statsByWeek,
  statsByMonth,
  statsByBook,
  getTotalYuan,
  getTotalChars,
  formatCost,
  type DayStat,
  type PeriodStat,
  type BookStat,
} from '../utils/costTracker'

type TabMode = 'day' | 'week' | 'month' | 'book'

const TABS: { id: TabMode; label: string }[] = [
  { id: 'day', label: '按天' },
  { id: 'week', label: '按周' },
  { id: 'month', label: '按月' },
  { id: 'book', label: '按书' },
]

function formatChars(chars: number): string {
  if (chars >= 10_000) return `${(chars / 10_000).toFixed(1)}万字`
  return `${chars}字`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  if (sameDay) return '今天'
  if (isYesterday) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function CostPage() {
  const [mode, setMode] = useState<TabMode>('day')
  const [refreshKey, setRefreshKey] = useState(0)
  const [totalYuan, setTotalYuan] = useState(0)
  const [totalChars, setTotalChars] = useState(0)
  const [dayStats, setDayStats] = useState<DayStat[]>([])
  const [weekStats, setWeekStats] = useState<PeriodStat[]>([])
  const [monthStats, setMonthStats] = useState<PeriodStat[]>([])
  const [bookStats, setBookStats] = useState<BookStat[]>([])

  // 因为 costTracker 接口是异步的，用 useEffect + state 加载；并且 mount 后每 30s 自动刷新
  useEffect(() => {
    let cancelled = false
    async function load() {
      const [yuan, chars, ds, ws, ms, bs] = await Promise.all([
        getTotalYuan(),
        getTotalChars(),
        mode === 'day' ? statsByDay(30) : Promise.resolve([] as DayStat[]),
        mode === 'week' ? statsByWeek(8) : Promise.resolve([] as PeriodStat[]),
        mode === 'month' ? statsByMonth(6) : Promise.resolve([] as PeriodStat[]),
        mode === 'book' ? statsByBook() : Promise.resolve([] as BookStat[]),
      ])
      if (cancelled) return
      setTotalYuan(yuan)
      setTotalChars(chars)
      setDayStats(ds)
      setWeekStats(ws)
      setMonthStats(ms)
      setBookStats(bs)
    }
    void load()
    const t = setInterval(() => void load(), 30000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [mode, refreshKey])

  const hasData = totalChars > 0

  // 当前 tab 过滤后的列表
  const currentList: (DayStat | PeriodStat | BookStat)[] = (() => {
    switch (mode) {
      case 'day': return dayStats.filter((s) => s.chars > 0)
      case 'week': return weekStats.filter((s) => s.chars > 0)
      case 'month': return monthStats.filter((s) => s.chars > 0)
      case 'book': return bookStats
    }
  })()

  const listEmpty = currentList.length === 0

  return (
    <div>
      <header className="page-header">
        <h1>花费</h1>
        <p className="sub">语音合成费用统计 · ¥2/万字</p>
      </header>

      {/* 总览卡片 */}
      <div className="cost-summary">
        <div className="cost-summary-item">
          <span className="cost-summary-value">{formatCost(totalYuan)}</span>
          <span className="cost-summary-label">累计花费</span>
        </div>
        <div className="cost-summary-item">
          <span className="cost-summary-value">{formatChars(totalChars)}</span>
          <span className="cost-summary-label">累计合成</span>
        </div>
        <button
          type="button"
          className="btn-ghost cost-refresh"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          刷新
        </button>
      </div>

      {/* 维度切换 */}
      <div className="cost-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`cost-tab${mode === t.id ? ' active' : ''}`}
            onClick={() => setMode(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!hasData ? (
        <div className="empty-state">
          还没有合成记录。在书架中打开一本书，点击「听」开始朗读后，这里会出现花费统计。
        </div>
      ) : listEmpty ? (
        <div className="empty-state">该时段暂无合成记录。</div>
      ) : (
        <div className="cost-list">
          {/* 按天 */}
          {mode === 'day' &&
            (currentList as DayStat[]).map((s) => (
              <div key={s.date} className="cost-row">
                <div className="cost-row-left">
                  <div className="cost-row-label">{formatDate(s.date)}</div>
                  <div className="cost-row-sub">
                    {formatChars(s.chars)} · {s.records} 次
                  </div>
                </div>
                <div className="cost-row-right">{formatCost(s.yuan)}</div>
              </div>
            ))}

          {/* 按周 */}
          {mode === 'week' &&
            (currentList as PeriodStat[]).map((s) => (
              <div key={s.label} className="cost-row">
                <div className="cost-row-left">
                  <div className="cost-row-label">{s.label} 起</div>
                  <div className="cost-row-sub">{formatChars(s.chars)}</div>
                </div>
                <div className="cost-row-right">{formatCost(s.yuan)}</div>
              </div>
            ))}

          {/* 按月 */}
          {mode === 'month' &&
            (currentList as PeriodStat[]).map((s) => (
              <div key={s.label} className="cost-row">
                <div className="cost-row-left">
                  <div className="cost-row-label">{s.label}</div>
                  <div className="cost-row-sub">{formatChars(s.chars)}</div>
                </div>
                <div className="cost-row-right">{formatCost(s.yuan)}</div>
              </div>
            ))}

          {/* 按书 */}
          {mode === 'book' &&
            (currentList as BookStat[]).map((s) => (
              <div key={s.bookTitle} className="cost-row">
                <div className="cost-row-left">
                  <div className="cost-row-label">{s.bookTitle}</div>
                  <div className="cost-row-sub">
                    {formatChars(s.chars)} · {s.records} 次 · 最后 {formatDate(s.lastDate)}
                  </div>
                </div>
                <div className="cost-row-right">{formatCost(s.yuan)}</div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
