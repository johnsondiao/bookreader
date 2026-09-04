/**
 * 字数统计与语音合成费用估算。
 *
 * 计费口径刻意与 tts.ts 的实际扣费保持一致：
 *   tts.ts 的 buildTextAndRanges() 把每段 trim 后用 '\n' 拼成 fullText，
 *   整章再按句切分逐段请求 MiniMax，addSynthChars 记的是 fullText 区间长度，
 *   所以「整章实际计费字符数 ≈ 段落 trim 后长度之和 + 段间 \n」。
 * 直接用 content.length 会把缩进、空行、连续换行都算进去，估算明显虚高。
 *
 * 单价见 minimaxTts.TTS_COST_PER_MILLION（Turbo ¥200/百万字符 = ¥2/万字）。
 */
import { estimateTtsCost } from './minimaxTts'

/**
 * 统计一段文本的计费字数（与 TTS 实际请求的字符数对齐）。
 * 超长段落 TTS 侧还会再切刀并 trim，误差在千分之一以内，估算足够用。
 */
export function countSpeakableChars(text: string): number {
  if (!text) return 0
  let chars = 0
  let paras = 0
  for (const raw of text.split(/\n+/)) {
    const t = raw.trim()
    if (!t) continue
    chars += t.length
    paras++
  }
  // 段与段之间的 '\n' 也在 fullText 里，同样计费
  return chars + Math.max(0, paras - 1)
}

/** 字数 → 预计费用（元）。负数按 0 处理，避免异常输入显示负金额 */
export function costOfChars(chars: number): number {
  return estimateTtsCost(Math.max(0, chars))
}

/** 章节计费字数：优先取已统计的 charCount，旧数据缺失时现算（不写回） */
export function charsOfChapter(ch: { content?: string; charCount?: number } | undefined): number {
  if (!ch) return 0
  if (typeof ch.charCount === 'number') return ch.charCount
  return countSpeakableChars(ch.content || '')
}

/**
 * 为章节补齐 charCount 并汇总全书字数。
 * 已带 charCount 的章节沿用旧值，不重复扫描全文。
 */
export function withCharStats<T extends { content?: string; charCount?: number }>(
  chapters: T[],
): { chapters: T[]; totalChars: number } {
  let totalChars = 0
  const out = chapters.map((c) => {
    const chars = charsOfChapter(c)
    totalChars += chars
    return { ...c, charCount: chars }
  })
  return { chapters: out, totalChars }
}

/** 字数展示：<1万 原样，≥1万 用「万」，≥1亿 用「亿」 */
export function formatCharCount(chars: number): string {
  const n = Math.max(0, Math.round(chars))
  if (n < 10_000) return `${n}字`
  if (n < 100_000_000) {
    const w = n / 10_000
    return `${w.toFixed(w >= 100 ? 0 : 1)}万字`
  }
  return `${(n / 100_000_000).toFixed(2)}亿字`
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

/** 「1.2万字 · ¥2.40」一行式标签，列表/卡片里直接用 */
export function formatCharsCost(chars: number): string {
  return `${formatCharCount(chars)} · ${formatCostEstimate(costOfChars(chars))}`
}
