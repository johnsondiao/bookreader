import type { Chapter } from '../types'

const CHAPTER_RE = /^(第[零一二三四五六七八九十百千0-9]+[章节回卷部集]|Chapter\s+\d+|CHAPTER\s+\d+)[^\n]*/gm

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

/** 按段落拆分，便于朗读定位 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
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
