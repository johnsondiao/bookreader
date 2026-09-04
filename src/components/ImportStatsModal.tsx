import { useMemo, useState } from 'react'
import type { Book } from '../types'
import { billableOfChapter, charsOfChapter, costOfBillable, formatCharCount, formatCostEstimate } from '../utils/charStats'

interface Props {
  book: Book
  /** 点「开始阅读」：打开阅读器 */
  onRead: () => void
  /** 点「留在书架」/ 点遮罩：只关弹窗 */
  onClose: () => void
}

/** 首屏只渲染这么多章，万章网文一次全渲染会卡住弹窗动画 */
const INITIAL_ROWS = 120
const ROWS_STEP = 400

/**
 * 导入结果弹窗：全书字数 + 预估合成费用 + 每章明细。
 * 字数口径与 TTS 实际扣费一致（见 utils/charStats）。
 */
export function ImportStatsModal({ book, onRead, onClose }: Props) {
  const [limit, setLimit] = useState(INITIAL_ROWS)

  const stats = useMemo(
    () =>
      (book.chapters || []).map((c, i) => {
        const chars = charsOfChapter(c)
        const billable = billableOfChapter(c)
        return { index: i, id: c.id, title: c.title, chars, yuan: costOfBillable(billable), billable }
      }),
    // 依赖用 book.chapters 本体：写成 `book.chapters || []` 会每次渲染产生新空数组，memo 直接失效
    [book.chapters],
  )
  const totalChars = useMemo(() => stats.reduce((s, r) => s + r.chars, 0), [stats])
  const totalBillable = useMemo(() => stats.reduce((s, r) => s + r.billable, 0), [stats])
  const rows = limit >= stats.length ? stats : stats.slice(0, limit)
  const rest = stats.length - rows.length

  return (
    <div className="stats-mask" onClick={onClose}>
      <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
        <h3>导入成功</h3>
        <div className="stats-book">
          <span className="emoji" style={{ background: book.coverColor }}>
            {book.coverEmoji}
          </span>
          <div className="stats-book-text">
            <div className="stats-book-title">{book.title}</div>
            <div className="stats-book-author">{book.author}</div>
          </div>
        </div>

        <div className="stats-grid">
          <div className="stats-cell">
            <span className="v">{stats.length}</span>
            <span className="l">章节</span>
          </div>
          <div className="stats-cell">
            <span className="v">{formatCharCount(totalChars)}</span>
            <span className="l">全书字数</span>
          </div>
          <div className="stats-cell">
            <span className="v accent">{formatCostEstimate(costOfBillable(totalBillable))}</span>
            <span className="l">全部朗读约需</span>
          </div>
        </div>

        <p className="stats-note">
          按 MiniMax Turbo ¥2/万计费字符估算（1 个汉字算 2 个字符，标点/英文算 1 个），
          实际以合成的字符数计费；已合成过的章节走本地缓存，不会重复扣费。
        </p>

        <div className="stats-list-head">
          <span>各章明细</span>
          <span className="muted">字数 · 预估费用</span>
        </div>
        <div className="stats-list">
          {rows.map((r) => (
            <div className="stats-row" key={r.id}>
              <span className="stats-row-idx">{r.index + 1}</span>
              <span className="stats-row-title">{r.title}</span>
              <span className="stats-row-chars">{formatCharCount(r.chars)}</span>
              <span className="stats-row-cost">{formatCostEstimate(r.yuan)}</span>
            </div>
          ))}
          {rest > 0 && (
            <button type="button" className="stats-more" onClick={() => setLimit((n) => n + ROWS_STEP)}>
              展开剩余 {rest} 章
            </button>
          )}
          {stats.length === 0 && <div className="stats-empty">本书没有可统计的章节</div>}
        </div>

        <div className="stats-buttons">
          <button type="button" className="stats-btn cancel" onClick={onClose}>
            留在书架
          </button>
          <button type="button" className="stats-btn ok" onClick={onRead}>
            开始阅读
          </button>
        </div>
      </div>
    </div>
  )
}
