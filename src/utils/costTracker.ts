/**
 * 按天记录语音合成花费，localStorage 持久化。
 *
 * 结构：{ "2026-08-08": 12345, "2026-08-07": 678, ... }
 * key = 日期字符串，value = 当天合成的字符数（计费按字符数算）
 */
import { TTS_COST_PER_MILLION } from './minimaxTts'

const STORAGE_KEY = 'langyue-tts-cost-by-day'

type CostMap = Record<string, number> // { "YYYY-MM-DD": charCount }

function load(): CostMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj as CostMap : {}
  } catch {
    return {}
  }
}

function save(map: CostMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

function todayKey(): string {
  const d = new Date()
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 记录一次合成调用花费的字符数 */
export function addSynthChars(chars: number) {
  if (chars <= 0) return
  const map = load()
  const key = todayKey()
  map[key] = (map[key] || 0) + chars
  save(map)
}

/** 获取今日已合成的字符数 */
export function getTodayChars(): number {
  return load()[todayKey()] || 0
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
