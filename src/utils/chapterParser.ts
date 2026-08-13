/**
 * 章节标题识别规则（支持选集类书籍的三级结构：卷 → 篇 → 章/节）：
 *
 * 1. 严格章节（100% 匹配，优先）：
 *    第X章/节/回/卷/集/部/篇  Chapter X
 *
 * 2. 带括号的日期副标题（选集常见，如"（一九二七年三月）"）：
 *    上一行是短标题，这一行是纯 (YYYY年MM月) 样式，两行合并为一个标题
 *
 * 3. 孤立短标题兜底（只有匹配不上任何规则时才启用）：
 *    一个行：长度 ≤ 40 字、单独成行（前后有空行）、
 *    不以标点/数字/常见正文开头词开头，视为一个新章节的标题。
 *    这用于「湖南农民运动考察报告」这种没有"第X章"字样的文章。
 *
 * 注意：孤立标题容易误判，所以只有在规则1/2 命中数太少时才启用。
 */
import type { Chapter } from '../types'

/** 1. 严格章节标题（卷/篇/章/节/回/集/部）
 *  ——关键字后必须带空白或结束，避免"第3天""第一节火车"之类的正文短句误判。
 */
const STRICT_CHAPTER_RE = /^(第[零一二三四五六七八九十百千0-9]+[章节回卷部集篇编部分节附录](?!\S)|Chapter\s+\d+(?:[\s:：]|$)|CHAPTER\s+\d+(?:[\s:：]|$)|Chapter\s+[IVXLCDM]+(?:[\s:：]|$)|CHAPTER\s+[IVXLCDM]+(?:[\s:：]|$)|Part\s+\d+(?:[\s:：]|$)|PART\s+\d+(?:[\s:：]|$))[^\n]*$/gm

/** 2. 选集日期副标题行，如"（一九二七年三月）" 或 "(1927.3)" */
const DATE_SUBTITLE_RE = /^(（|\()\s*(\d{2,4}|[一二三四五六七八九十〇]+)\s*年.*?(）|\))\s*$/
/** 3. 正文中不会出现在句首的关键词，用来过滤误判标题 */
const BODY_PREFIX_RE = /^(但是|所以|因此|于是|然而|因为|所以|接着|然后|同时|另外|而且|不过|并且|这时|此时|当时|曾经|已经|还是|或者|如果|虽然|尽管|关于|对于|通过|根据|按照|为了|鉴于|目前|现在|过去|未来|以上|以下|以上|总之|综上|可见|显然|当然|必须|应该|需要|我们|你们|他们|她们|它们|这个|那个|这些|那些|这样|那样|因此|于是|一[\s、，。])/u

/** 短标题长度上限（字） */
const TITLE_MAX_LEN = 40
/** 启用"孤立标题兜底"的阈值：严格标题数 < 该值时启用兜底 */
const MIN_STRICT_CHAPTERS = 2
/** 严格/兜底都命中 < MIN_CHAPTERS_TOTAL 时，说明无明显章节结构，不拆分（避免乱切） */
const MIN_CHAPTERS_TOTAL = 3

/** 4. 数字编号标题（网文常见）："004 【杀人越货】"、"12、风起长安"、"3. 暗流"
 *  —— 数字后必须有标题性文字，纯数字行不算 */
const NUM_TITLE_RE = /^\d{1,4}\s*[.、．:：]?\s*[【\[《（(]?.{1,38}$/
/** 行尾句末标点（含可选的引号收尾）：有则视为正文句而非标题 */
const ENDS_SENTENCE_RE = /[。，、；：！？,.;:!?…]["”’』」\])》]*$/

type TitleHit = {
  index: number
  /** 标题文本（含可能的日期副标题） */
  title: string
  /** 是否为严格标题（true 时 100% 确信） */
  strict: boolean
}

/** 一个行（记录起始偏移，便于切回原文） */
type LinePos = {
  start: number
  end: number
  text: string
  /** 前一个字符（行前是否是空行/文件起始） */
  precededByBlank: boolean
  /** 后一个字符（行后是否是空行/文件末尾） */
  followedByBlank: boolean
}

function getAllLines(text: string): LinePos[] {
  const lines: LinePos[] = []
  const regex = /[^\n]+/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const preceded = start === 0 || text[start - 1] === '\n' && (start - 2 < 0 || text[start - 2] === '\n')
    const followed = end === text.length || text[end] === '\n' && (end + 1 >= text.length || text[end + 1] === '\n')
    lines.push({ start, end, text: m[0], precededByBlank: preceded, followedByBlank: followed })
  }
  return lines
}

/** 判断某行是否像章节标题：短、单独成行、不以正文字眼开头 */
function looksLikeStandaloneTitle(line: LinePos): boolean {
  const t = line.text.trim()
  if (!t || t.length > TITLE_MAX_LEN) return false
  if (t.length < 2) return false
  // 必须空行包围（避免正文短句误判）
  if (!(line.precededByBlank && line.followedByBlank)) return false
  // 不能有句号/逗号等句末标点在末尾
  if (/[。，、；：,.;:!?！？]$/.test(t)) return false
  // 不能以数字/年份开头（正文常有的"2023年"这种）
  if (/^[0-9（(【\[]/.test(t)) return false
  // 不能是正文中常见句首词
  if (BODY_PREFIX_RE.test(t)) return false
  // 不能是纯标点或符号组合
  if (/^[\s\p{P}\p{S}]+$/u.test(t)) return false
  // 排除"注释"标题行（这是注释类型，不是新章节）
  if (/^(注[释解]?|附[注记]|备?注|NOTE[S]?)$/i.test(t)) return false
  // 排除日期副标题行（和上一行合并）
  if (DATE_SUBTITLE_RE.test(t)) return false
  return true
}

/**
 * 数字编号标题探测（仅当严格标题太少时调用）。
 * 防误判：命中数 ≥ 3 且编号大体递增（容忍少量噪声）才采信。
 */
function findNumberedTitles(lines: LinePos[]): TitleHit[] {
  const cand: { line: LinePos; num: number }[] = []
  for (const line of lines) {
    const t = line.text.trim()
    if (!t || t.length > TITLE_MAX_LEN) continue
    if (!NUM_TITLE_RE.test(t)) continue
    if (ENDS_SENTENCE_RE.test(t)) continue
    // 标题行前应是空行（避免段内数字开头的正文句）
    if (!line.precededByBlank) continue
    const num = parseInt(t.match(/^\d+/)?.[0] ?? '', 10)
    cand.push({ line, num })
  }
  if (cand.length < MIN_CHAPTERS_TOTAL) return []
  let increasing = 0
  for (let i = 1; i < cand.length; i++) {
    if (cand[i].num > cand[i - 1].num) increasing++
  }
  if (increasing < (cand.length - 1) * 0.7) return []
  return cand.map((c) => ({ index: c.line.start, title: c.line.text.trim(), strict: true }))
}

export function parseChapters(content: string): Chapter[] {
  // 兼容 \r\n 和单独 \r（老 txt 文件可能只有 \r）
  const text = content.replace(/\r\n?/g, '\n').trim()
  if (!text) return []

  // —— 1. 先收集所有严格标题 ——
  const strictHits: TitleHit[] = []
  const strictMatches = [...text.matchAll(STRICT_CHAPTER_RE)]
  for (const m of strictMatches) {
    strictHits.push({
      index: m.index ?? 0,
      title: m[0].trim(),
      strict: true,
    })
  }

  // —— 2. 严格标题太少时，先试数字编号标题（网文风格），再启用"孤立短标题兜底" ——
  const lines = getAllLines(text)
  const numHits: TitleHit[] =
    strictHits.length < MIN_STRICT_CHAPTERS ? findNumberedTitles(lines) : []
  const fallbackHits: TitleHit[] = []
  if (strictHits.length + numHits.length < MIN_STRICT_CHAPTERS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const next = lines[i + 1]
      if (!looksLikeStandaloneTitle(line)) continue
      // 避免和严格标题重复（同一行位置）
      if (strictHits.some((h) => h.index === line.start)) continue
      // 合并日期副标题：下一行是纯日期行且空行包围
      let titleText = line.text.trim()
      if (next && DATE_SUBTITLE_RE.test(next.text.trim())) {
        titleText = `${titleText} ${next.text.trim()}`
      }
      fallbackHits.push({ index: line.start, title: titleText, strict: false })
    }
  }

  // —— 3. 合并排序 ——
  const allHits = [...strictHits, ...numHits, ...fallbackHits].sort((a, b) => a.index - b.index)

  // —— 4. 如果总共命中的章节太少，说明无明显章节结构，不拆分 ——
  if (allHits.length < MIN_CHAPTERS_TOTAL) {
    return [
      {
        id: 'ch-0',
        title: '正文',
        startIndex: 0,
        content: text,
      },
    ]
  }

  // —— 5. 按命中切分章节 ——
  const chapters: Chapter[] = []
  for (let i = 0; i < allHits.length; i++) {
    const hit = allHits[i]
    const start = hit.index
    const end = i + 1 < allHits.length ? allHits[i + 1].index : text.length
    const chunk = text.slice(start, end).trim()
    const lines2 = chunk.split('\n')
    // 如果标题里含日期（由 fallback 合并逻辑写入的），正文从日期副标题之后开始
    let bodyStartLine = 1
    if (hit.title.includes(' ') && DATE_SUBTITLE_RE.test(lines2[1]?.trim() || '')) {
      bodyStartLine = 2
    }
    const body = lines2.slice(bodyStartLine).join('\n').trim()
    chapters.push({
      id: `ch-${i}`,
      title: hit.title,
      startIndex: start,
      content: body || chunk,
    })
  }
  return chapters
}

/** 段落类型：正文 vs 注释（注释段朗读时会切换到注释音色） */
export type ParagraphKind = 'text' | 'note'

export interface Paragraph {
  /** 纯文本（用于朗读与渲染） */
  text: string
  /** 类型：正文 / 注释 */
  kind: ParagraphKind
}

/**
 * 注释段落判定（按渲染文本的视觉特征，匹配你提供的《中国社会各阶级的分析·注释》样式）：
 *   1. 标题行：仅含「注释 / 注 释 / 注解」等字样，且无正文内容
 *   2. * 号前缀：`*`、`＊`、`•`、`·`、`○`、`※`、`★` 开头，后接空格或中文
 *   3. 方括号编号：`[1]`、`〔1〕`、`（1）`、`【1】`、`〖1〗` 开头，后接空格或中文
 *   4. 阿拉伯数字点号：`1. `、`2、`、`3）`、`4〕`、`5］` 开头（< 999 以避免误判正文年份）
 */
const NOTE_TITLE_RE = /^(注[释解]?|注\s*释|附[注记]|备?注|NOTE[S]?|注释|注解)\s*[:：]?$/i
const BULLET_RE = /^[\*＊•·○※★✦❖]\s*/
const BRACKET_NO_RE = /^[\[【（(〔〖]\s*\d+\s*[\]】）)〕〗]\s*/
const NUMBER_PREFIX_RE = /^\d{1,3}\s*[.、。:：)）〕］]\s*/

export function isNoteParagraph(text: string, prevKind: ParagraphKind | undefined): ParagraphKind {
  const t = text.trim()
  if (!t) return 'text'
  // 纯标题行：作为注释段标题（朗读时也算注释音色，读「注释」二字）
  if (NOTE_TITLE_RE.test(t)) return 'note'
  if (BULLET_RE.test(t)) return 'note'
  if (BRACKET_NO_RE.test(t)) return 'note'
  if (NUMBER_PREFIX_RE.test(t)) return 'note'
  // 上一段是注释，且当前段无段落开头标记，视为注释延续
  if (prevKind === 'note') return 'note'
  return 'text'
}

/** 单段过长时再切刀，避免一个巨大 DOM 文本节点卡死页面 */
const MAX_PARA_CHARS = 600

const SPLIT_PUNCT = ['。', '！', '？', '；', '. ', '! ', '? ']

function breakLongPara(p: Paragraph): Paragraph[] {
  if (p.text.length <= MAX_PARA_CHARS) return [p]
  const out: Paragraph[] = []
  let rest = p.text
  while (rest.length > MAX_PARA_CHARS) {
    const window = rest.slice(0, MAX_PARA_CHARS)
    let breakAt = -1
    for (const mark of SPLIT_PUNCT) {
      const i = window.lastIndexOf(mark)
      if (i > breakAt) breakAt = i
    }
    const cut = breakAt > MAX_PARA_CHARS * 0.4 ? breakAt + 1 : MAX_PARA_CHARS
    const piece = rest.slice(0, cut).trim()
    if (piece) out.push({ text: piece, kind: p.kind })
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push({ text: rest, kind: p.kind })
  return out
}

/** 按段落拆分，带类型（text/note），便于朗读切换音色 */
export function splitParagraphs(text: string): Paragraph[] {
  const raw = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)

  const out: Paragraph[] = []
  let prev: ParagraphKind | undefined
  for (const line of raw) {
    const kind = isNoteParagraph(line, prev)
    const paras = breakLongPara({ text: line, kind })
    for (const para of paras) {
      out.push(para)
      prev = para.kind
    }
  }
  return out
}

/** 兼容旧代码：返回纯文本数组（Store 里计算进度用，不需要类型） */
export function splitParagraphTexts(text: string): string[] {
  return splitParagraphs(text).map((p) => p.text)
}

export function calcProgress(chapterIndex: number, chapterCount: number, paragraphIndex: number, paragraphCount: number): number {
  if (chapterCount <= 0) return 0
  const chapterPart = chapterIndex / chapterCount
  const paraPart = paragraphCount > 0 ? paragraphIndex / paragraphCount / chapterCount : 0
  return Math.min(99.9, Math.round((chapterPart + paraPart) * 1000) / 10)
}

export function guessTitleFromContent(content: string, filename?: string): string {
  if (filename) {
    const base = filename.replace(/\.[^.]+$/, '').trim()
    if (base) return base
  }
  const firstLine = content.split(/\n/).map((l) => l.trim()).find(Boolean)
  if (firstLine && firstLine.length <= 30 && !/^(第[零一二三四五六七八九十百千0-9]+[章节回卷部集])/.test(firstLine)) {
    return firstLine
  }
  return '未命名书籍'
}

export const COVER_COLORS = ['#8B3A3A', '#2F4A6B', '#3D5A3D', '#6B4F2F', '#4A3A6B', '#2F5A5A', '#5A3A2F', '#3A4A5A']

/** 判断字符是否为句子结束标点（中英文），与 TTS planSegments 使用同一逻辑 */
export function isSentenceEnd(ch: string): boolean {
  return '。！？；…\n'.includes(ch) || '.!?;'.includes(ch)
}

/**
 * 将段落文本按句子切分（与 TTS planSegments 完全一致的切分逻辑）。
 * 返回句子数组（含结束标点），空句子被过滤。
 * 确保 ReaderPage 的句子索引和 TTS 的 segment 索引一一对应。
 */
export function splitSentences(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  let sentStart = 0
  for (let ci = 0; ci < text.length; ci++) {
    if (isSentenceEnd(text[ci])) {
      const sentence = text.slice(sentStart, ci + 1)
      if (sentence) out.push(sentence)
      sentStart = ci + 1
    }
  }
  if (sentStart < text.length) {
    const rest = text.slice(sentStart)
    if (rest) out.push(rest)
  }
  return out
}
