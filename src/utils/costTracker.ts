/**
 * 语音合成花费记录，IndexedDB 持久化（含 localStorage 旧数据迁移）。
 *
 * 性能优化：内存缓存 + 防抖写入（每 10 次或 5 秒批量写一次）。
 * 存储结构：CostRecord[]
 * 每条记录包含：日期、书名、字符数。
 * 通过这些记录可按天/周/月/书名进行聚合统计。
 */
import { TTS_COST_PER_MILLION } from './minimaxTts'
import { openDb } from './audioCache'

const STORE_NAME = 'costs'
const LS_KEY = 'langyue-tts-cost-records'
const OLD_LS_KEY = 'langyue-tts-cost-by-day'
const MAX_RECORDS = 5000
const SAVE_DEBOUNCE_MS = 5000
const SAVE_BATCH_COUNT = 10

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

/* ====== 内存缓存 + 防抖持久化 ====== */

let records: CostRecord[] = []
let initPromise: Promise<void> | null = null
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingCount = 0

async function loadFromIdb(): Promise<CostRecord[]> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const all: CostRecord[] = await new Promise((resolve, reject) => {
      const req = store.getAll()
      req.onsuccess = () => resolve(req.result ?? [])
      req.onerror = () => reject(req.error)
    })
    return all
  } catch {
    return []
  }
}

async function saveToIdb(all: CostRecord[]): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    // 清空后全量写入（简单可靠，数据量小）
    await new Promise<void>((resolve, reject) => {
      const req = store.clear()
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    for (let i = 0; i < all.length; i++) {
      store.put({ ...all[i], id: i })
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* IDB 写入失败不阻塞，内存数据仍有效 */
  }
}

/** 迁移 localStorage 旧数据 */
function migrateFromLs(): CostRecord[] {
  try {
    // 清理旧 key
    const oldRaw = localStorage.getItem(OLD_LS_KEY)
    if (oldRaw) {
      try { localStorage.removeItem(OLD_LS_KEY) } catch { /* ignore */ }
    }
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length > 0) {
      try { localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
      return arr
    }
  } catch { /* ignore */ }
  return []
}

function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!dirty) return Promise.resolve()
  dirty = false
  pendingCount = 0
  return saveToIdb([...records])
}

function scheduleSave() {
  pendingCount++
  dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  if (pendingCount >= SAVE_BATCH_COUNT) {
    flushSave()
  } else {
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  }
}

async function init(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    // 优先从 IDB 加载
    let stored = await loadFromIdb()
    // IDB 为空则尝试迁移 localStorage
    if (stored.length === 0) {
      stored = migrateFromLs()
      if (stored.length > 0) {
        await saveToIdb(stored)
      }
    }
    records = stored
  })()
  return initPromise
}

// 启动时异步初始化
void init()

/* ====== 公共 API ====== */

function todayKey(): string {
  const d = new Date()
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 记录一次合成调用（异步确保 init 完成，避免初始化前新记录被覆盖） */
export async function addSynthChars(chars: number, bookTitle: string): Promise<void> {
  if (chars <= 0) return
  await init()
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
  scheduleSave()
}

/** 获取今日已合成的字符数（读取前确保初始化完成） */
export async function getTodayChars(): Promise<number> {
  await init()
  const today = todayKey()
  return records.filter((r) => r.date === today).reduce((s, r) => s + r.chars, 0)
}

/** 获取今日已花费的金额（元） */
export async function getTodayCostYuan(): Promise<number> {
  const c = await getTodayChars()
  return (c / 1_000_000) * TTS_COST_PER_MILLION
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
export async function statsByDay(days = 30): Promise<DayStat[]> {
  await init()
  const map = new Map<string, { chars: number; records: number }>()
  for (const r of records) {
    const cur = map.get(r.date) || { chars: 0, records: 0 }
    cur.chars += r.chars
    cur.records += 1
    map.set(r.date, cur)
  }
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
export async function statsByWeek(weeks = 8): Promise<PeriodStat[]> {
  await init()
  const now = new Date()
  const curDay = now.getDay() || 7
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
export async function statsByMonth(months = 6): Promise<PeriodStat[]> {
  await init()
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
export async function statsByBook(): Promise<BookStat[]> {
  await init()
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
export async function getTotalYuan(): Promise<number> {
  await init()
  return charsToYuan(records.reduce((s, r) => s + r.chars, 0))
}

/** 总字符数 */
export async function getTotalChars(): Promise<number> {
  await init()
  return records.reduce((s, r) => s + r.chars, 0)
}

/** 确保数据已持久化（页面关闭前调用，await 等待写入完成） */
export async function flushCostTracker(): Promise<void> {
  await flushSave()
}

/**
 * 检查今日花费是否超出预算上限（内部 await init 保证数据最新）。
 */
export async function checkBudget(
  budgetYuan?: number,
): Promise<{ exceeded: boolean; todayYuan: number; budgetYuan: number } | null> {
  if (!budgetYuan || budgetYuan <= 0) return null
  const todayYuan = await getTodayCostYuan()
  if (todayYuan >= budgetYuan) {
    return { exceeded: true, todayYuan, budgetYuan }
  }
  return null
}