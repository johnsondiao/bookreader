/**
 * 字数统计与语音合成费用估算。
 *
 * ⚠️ 两套口径，不能混用：
 *   1) 显示字数 chars —— 给人看的「这章多少字」。= 段落 trim 后按 \n 拼接的长度，
 *      与 tts.ts buildTextAndRanges() 产出的 fullText 一致（不含缩进、空行）。
 *   2) 计费字符 billable —— MiniMax 官方规则（平台 → 按量计费 → 语音）：
 *      「计费项是字符数，1 个汉字算 2 个字符，英文字母、希腊字母、标点符号、
 *        特殊符号、空格、回车等算 1 个字符」，speech-2.8-turbo 单价 ¥2/万计费字符。
 *      所以 billable = JS 长度 + 汉字数。
 *
 * 金额一律由 billable 算。历史上全程用 JS 长度（1 汉字=1）算钱，预估、花费页、
 * 今日已耗、每日预算全都只有实际账单的一半左右，预算上限形同虚设。
 */
import { estimateTtsCost } from './minimaxTts'

/** 统计口径版本：改过计数规则就 bump，已持久化的旧统计值会被重算 */
export const CHAR_STATS_VERSION = 2

/** CJK 统一表意文字（基本区 + 扩展 A + 兼容区）：这些按 2 个计费字符算 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g

/** 文本里的汉字个数 */
export function countCjkChars(text: string): number {
  if (!text) return 0
  return text.match(CJK_RE)?.length ?? 0
}

/**
 * MiniMax 计费字符数：汉字算 2，其余算 1。
 * 实现取「JS 长度 + 汉字数」：BMP 汉字 JS 长度 1 → 合计 2；扩展 B 区等代理对汉字
 * JS 长度本就是 2、又不落在上面的 BMP 范围里 → 合计同样是 2，正好符合规则。
 * 入参应是真正发给接口的文本（tts.ts 里就是那一句 segment）。
 */
export function countBillableChars(text: string): number {
  if (!text) return 0
  return text.length + countCjkChars(text)
}

/** 归一化成 TTS 真正会发送的文本：按 \n+ 分段、每段 trim、再用 \n 拼接 */
export function speakableText(text: string): string {
  if (!text) return ''
  const paras: string[] = []
  for (const raw of text.split(/\n+/)) {
    const t = raw.trim()
    if (t) paras.push(t)
  }
  return paras.join('\n')
}

/** 显示字数：这章有多少字（不含缩进、空行） */
export function countSpeakableChars(text: string): number {
  return speakableText(text).length
}

/** 一整段正文的计费字符数（先归一化，再按汉字×2 计） */
export function estimateBillableChars(text: string): number {
  return countBillableChars(speakableText(text))
}

/** 计费字符 → 金额（元）。负数按 0 处理，避免异常输入显示负金额 */
export function costOfBillable(billable: number): number {
  return estimateTtsCost(Math.max(0, billable))
}

/** 章节显示字数：优先取已统计值，旧数据缺失时现算（不写回） */
export function charsOfChapter(ch: { content?: string; charCount?: number } | undefined): number {
  if (!ch) return 0
  if (typeof ch.charCount === 'number') return ch.charCount
  return countSpeakableChars(ch.content || '')
}

/** 章节计费字符：优先取已统计值，旧数据缺失时现算（不写回） */
export function billableOfChapter(
  ch: { content?: string; billableChars?: number } | undefined,
): number {
  if (!ch) return 0
  if (typeof ch.billableChars === 'number') return ch.billableChars
  return estimateBillableChars(ch.content || '')
}

export interface BookCharStats<T> {
  chapters: (T & { charCount: number; billableChars: number })[]
  totalChars: number
  totalBillable: number
}

/**
 * 逐章统计显示字数与计费字符并汇总全书。
 * 一律按 content 重算（不复用旧字段）：口径升级后旧值必须作废，
 * 是否重扫由调用方用 CHAR_STATS_VERSION 控制，不在这里做半截优化。
 */
export function withCharStats<T extends { content?: string }>(chapters: T[]): BookCharStats<T> {
  let totalChars = 0
  let totalBillable = 0
  const out = chapters.map((c) => {
    const text = speakableText(c.content || '')
    const chars = text.length
    const billable = countBillableChars(text)
    totalChars += chars
    totalBillable += billable
    return { ...c, charCount: chars, billableChars: billable }
  })
  return { chapters: out, totalChars, totalBillable }
}

/** 字数展示：<1万 原样，≥1万 用「万」，≥1亿 用「亿」。unit 可换「字符」（计费量） */
export function formatCharCount(chars: number, unit = '字'): string {
  const n = Math.max(0, Math.round(chars))
  if (n < 10_000) return `${n}${unit}`
  if (n < 100_000_000) {
    const w = n / 10_000
    return `${w.toFixed(w >= 100 ? 0 : 1)}万${unit}`
  }
  return `${(n / 100_000_000).toFixed(2)}亿${unit}`
}

/**
 * 预估费用展示：
 * 估算值需要比 costTracker.formatCost（<1分 显示「不到1分」）更细一点，
 * 否则单章几百字的费用全挤成同一句话，看不出差异。
 */
export function formatCostEstimate(yuan: number): string {
  if (!Number.isFinite(yuan) || yuan <= 0) return '¥0'
  if (yuan < 0.001) return '<¥0.001'
  if (yuan < 1) return `¥${yuan.toFixed(3)}`
  if (yuan < 1000) return `¥${yuan.toFixed(2)}`
  return `¥${Math.round(yuan).toLocaleString('zh-CN')}`
}

/** 「1.2万字 · ¥4.80」一行式标签：字数用显示口径，金额用计费口径 */
export function formatCharsCost(chars: number, billable: number): string {
  return `${formatCharCount(chars)} · ${formatCostEstimate(costOfBillable(billable))}`
}
