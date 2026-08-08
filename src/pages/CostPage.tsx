import { useState, useMemo } from 'react'
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

  const totalYuan = useMemo(() => getTotalYuan(), [refreshKey])
  const totalChars = useMemo(() => getTotalChars(), [refreshKey])

  const dayStats = useMemo<DayStat[]>(() => statsByDay(30), [refreshKey])
  const weekStats = useMemo<PeriodStat[]>(() => statsByWeek(8), [refreshKey])
  const monthStats = useMemo<PeriodStat[]>(() => statsByMonth(6), [refreshKey])
  const bookStats = useMemo<BookStat[]>(() => statsByBook(), [refreshKey])

  const hasData = totalChars > 0

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
      ) : (
        <div className="cost-list">
          {/* 按天 */}
          {mode === 'day' &&
            dayStats
              .filter((s) => s.chars > 0)
              .map((s) => (
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
            weekStats
              .filter((s) => s.chars > 0)
              .map((s, i) => (
                <div key={i} className="cost-row">
                  <div className="cost-row-left">
                    <div className="cost-row-label">{s.label} 起</div>
                    <div className="cost-row-sub">{formatChars(s.chars)}</div>
                  </div>
                  <div className="cost-row-right">{formatCost(s.yuan)}</div>
                </div>
              ))}

          {/* 按月 */}
          {mode === 'month' &&
            monthStats
              .filter((s) => s.chars > 0)
              .map((s, i) => (
                <div key={i} className="cost-row">
                  <div className="cost-row-left">
                    <div className="cost-row-label">{s.label}</div>
                    <div className="cost-row-sub">{formatChars(s.chars)}</div>
                  </div>
                  <div className="cost-row-right">{formatCost(s.yuan)}</div>
                </div>
              ))}

          {/* 按书 */}
          {mode === 'book' &&
            bookStats.map((s) => (
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

          {/* 按天/周/月过滤后为空时 */}
          {(mode === 'day' || mode === 'week' || mode === 'month') &&
            (mode === 'day'
              ? dayStats
              : mode === 'week'
                ? weekStats
                : monthStats
            ).every((s) => s.chars === 0) && (
              <div className="empty-state">该时段暂无合成记录。</div>
            )}
        </div>
      )}
    </div>
  )
}
