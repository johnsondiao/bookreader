import type { Chapter } from '../types'

const CHAPTER_RE = /^(第[零一二三四五六七八九十百千0-9]+[章节回卷部集]|Chapter\s+\d+|CHAPTER\s+\d+)[^\n]*/gm

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

export function parseChapters(content: string): Chapter[] {
  const text = content.replace(/\r\n/g, '\n').trim()
  if (!text) return []

  const matches = [...text.matchAll(CHAPTER_RE)]
  if (matches.length === 0) {
    return [
      {
        id: 'ch-0',
        title: '正文',
        startIndex: 0,
        content: text,
      },
    ]
  }

  return matches.map((m, i) => {
    const start = m.index ?? 0
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length
    const chunk = text.slice(start, end).trim()
    const lines = chunk.split('\n')
    const title = (lines[0] || `第${i + 1}章`).trim()
    const body = lines.slice(1).join('\n').trim()
    return {
      id: `ch-${i}`,
      title,
      startIndex: start,
      content: body || chunk,
    }
  })
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
