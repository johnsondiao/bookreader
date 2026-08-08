/**
 * 语音合成花费记录，localStorage 持久化。
 *
 * 存储结构：CostRecord[]
 * 每条记录包含：日期、书名、字符数。
 * 通过这些记录可按天/周/月/书名进行聚合统计。
 */
import { TTS_COST_PER_MILLION } from './minimaxTts'

const STORAGE_KEY = 'langyue-tts-cost-records'
const OLD_STORAGE_KEY = 'langyue-tts-cost-by-day'
const MAX_RECORDS = 5000

export interface CostRecord {
  /** 日期 "YYYY-MM-DD" */
  date: string
  /** 书名 */
  bookTitle: string
  /** 本次合成字符数 */
  chars: number
  /** 时间戳 */
  ts: number
}

function load(): CostRecord[] {
  try {
    // 迁移旧数据：旧 key 是按天聚合的 { "YYYY-MM-DD": chars }，清理掉
    const oldRaw = localStorage.getItem(OLD_STORAGE_KEY)
    if (oldRaw) {
      try { localStorage.removeItem(OLD_STORAGE_KEY) } catch { /* ignore */ }
    }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function save(records: CostRecord[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch {
    /* ignore */
  }
}

function todayKey(): string {
  const d = new Date()
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 记录一次合成调用 */
export function addSynthChars(chars: number, bookTitle: string) {
  if (chars <= 0) return
  const records = load()
  records.push({
    date: todayKey(),
    bookTitle: bookTitle || '未知',
    chars,
    ts: Date.now(),
  })
  // 超过上限时丢弃最旧的记录
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS)
  }
  save(records)
}

/** 获取今日已合成的字符数 */
export function getTodayChars(): number {
  const today = todayKey()
  return load().filter((r) => r.date === today).reduce((s, r) => s + r.chars, 0)
}

/** 获取今日已花费的金额（元） */
export function getTodayCostYuan(): number {
  return (getTodayChars() / 1_000_000) * TTS_COST_PER_MILLION
}

/** 格式化金额：小于 1 分显示"不到1分"，否则显示 ¥x.xx */
export function formatCost(yuan: number): string {
  if (yuan < 0.01) return '不到1分'
  return `¥${yuan.toFixed(2)}`
}

function charsToYuan(chars: number): number {
  return (chars / 1_000_000) * TTS_COST_PER_MILLION
}

/* ====== 统计维度 ====== */

export interface DayStat {
  date: string
  chars: number
  yuan: number
  records: number
}

/** 按天聚合，返回最近 N 天（含今天），按日期倒序 */
export function statsByDay(days = 30): DayStat[] {
  const records = load()
  const map = new Map<string, { chars: number; records: number }>()
  for (const r of records) {
    const cur = map.get(r.date) || { chars: 0, records: 0 }
    cur.chars += r.chars
    cur.records += 1
    map.set(r.date, cur)
  }
  // 生成最近 N 天的列表（含今天，倒序）
  const out: DayStat[] = []
  const now = new Date()
  for (let i = 0; i < days; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const p = (n: number) => n.toString().padStart(2, '0')
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    const s = map.get(key)
    out.push({
      date: key,
      chars: s?.chars || 0,
      yuan: charsToYuan(s?.chars || 0),
      records: s?.records || 0,
    })
  }
  return out
}

export interface PeriodStat {
  label: string
  chars: number
  yuan: number
}

/** 按周聚合，返回最近 N 周（含本周），按周倒序 */
export function statsByWeek(weeks = 8): PeriodStat[] {
  const records = load()
  const now = new Date()
  // 找到本周一
  const curDay = now.getDay() || 7 // 周日=7
  const monday = new Date(now)
  monday.setDate(now.getDate() - curDay + 1)
  monday.setHours(0, 0, 0, 0)

  const out: PeriodStat[] = []
  for (let w = 0; w < weeks; w++) {
    const weekStart = new Date(monday)
    weekStart.setDate(monday.getDate() - w * 7)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    weekEnd.setHours(23, 59, 59, 999)

    const p = (n: number) => n.toString().padStart(2, '0')
    const label = `${weekStart.getFullYear()}.${p(weekStart.getMonth() + 1)}.${p(weekStart.getDate())}`

    let chars = 0
    for (const r of records) {
      const rd = new Date(r.date + 'T00:00:00')
      if (rd >= weekStart && rd <= weekEnd) chars += r.chars
    }
    out.push({ label, chars, yuan: charsToYuan(chars) })
  }
  return out
}

/** 按月聚合，返回最近 N 个月（含本月），按月倒序 */
export function statsByMonth(months = 6): PeriodStat[] {
  const records = load()
  const now = new Date()
  const out: PeriodStat[] = []
  for (let m = 0; m < months; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1)
    const next = new Date(now.getFullYear(), now.getMonth() - m + 1, 1)
    const p = (n: number) => n.toString().padStart(2, '0')
    const label = `${d.getFullYear()}-${p(d.getMonth() + 1)}`
    let chars = 0
    for (const r of records) {
      const rd = new Date(r.date + 'T00:00:00')
      if (rd >= d && rd < next) chars += r.chars
    }
    out.push({ label, chars, yuan: charsToYuan(chars) })
  }
  return out
}

export interface BookStat {
  bookTitle: string
  chars: number
  yuan: number
  records: number
  lastDate: string
}

/** 按书名聚合，按字符数倒序 */
export function statsByBook(): BookStat[] {
  const records = load()
  const map = new Map<string, { chars: number; records: number; lastDate: string }>()
  for (const r of records) {
    const cur = map.get(r.bookTitle) || { chars: 0, records: 0, lastDate: '' }
    cur.chars += r.chars
    cur.records += 1
    if (r.date > cur.lastDate) cur.lastDate = r.date
    map.set(r.bookTitle, cur)
  }
  const out: BookStat[] = []
  for (const [bookTitle, s] of map) {
    out.push({
      bookTitle,
      chars: s.chars,
      yuan: charsToYuan(s.chars),
      records: s.records,
      lastDate: s.lastDate,
    })
  }
  return out.sort((a, b) => b.chars - a.chars)
}

/** 总花费 */
export function getTotalYuan(): number {
  return charsToYuan(load().reduce((s, r) => s + r.chars, 0))
}

/** 总字符数 */
export function getTotalChars(): number {
  return load().reduce((s, r) => s + r.chars, 0)
}
