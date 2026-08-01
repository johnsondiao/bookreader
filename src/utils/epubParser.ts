import JSZip from 'jszip'
import type { Chapter } from '../types'

export interface ParsedEbook {
  title: string
  author: string
  /** 已弃用双份存储：正文只在 chapters 里，此字段恒为空串 */
  content: string
  chapters: Omit<Chapter, 'id'>[]
}

export type EpubParseProgress = {
  phase: 'unzip' | 'chapters'
  current: number
  total: number
}

function decodeXml(text: string) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|BR)\s*\/?>/g, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  text = decodeXml(text)
  text = text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
}

/** 避免对超大 HTML 用非贪婪 [\s\S]*? 正则 */
function extractBody(html: string): string {
  const open = html.match(/<body\b[^>]*>/i)
  if (!open || open.index == null) return html
  const start = open.index + open[0].length
  const close = html.slice(start).match(/<\/body>/i)
  if (!close || close.index == null) return html.slice(start)
  return html.slice(start, start + close.index)
}

function dirname(path: string) {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

function resolvePath(baseDir: string, rel: string) {
  const clean = rel.split('#')[0].replace(/\\/g, '/')
  if (!baseDir) return clean.replace(/^\.\//, '')
  const parts = [...baseDir.split('/').filter(Boolean), ...clean.split('/')]
  const stack: string[] = []
  for (const p of parts) {
    if (p === '.' || !p) continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  return stack.join('/')
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))
  return m ? m[1] : null
}

function buildZipIndex(zip: JSZip) {
  const index = new Map<string, JSZip.JSZipObject>()
  const lowerIndex = new Map<string, JSZip.JSZipObject>()
  zip.forEach((relativePath, file) => {
    if (file.dir) return
    const path = relativePath.replace(/\\/g, '/')
    index.set(path, file)
    lowerIndex.set(path.toLowerCase(), file)
  })
  return { index, lowerIndex }
}

type ZipIndex = ReturnType<typeof buildZipIndex>

function findZipFile(zipIndex: ZipIndex, path: string) {
  const normalized = path.replace(/^\.\//, '').replace(/\\/g, '/')
  return (
    zipIndex.index.get(normalized) ||
    zipIndex.index.get(decodeURIComponent(normalized)) ||
    zipIndex.lowerIndex.get(normalized.toLowerCase()) ||
    null
  )
}

async function readZipText(zipIndex: ZipIndex, path: string): Promise<string | null> {
  const file = findZipFile(zipIndex, path)
  if (!file) return null
  return file.async('text')
}

function yieldToMain() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0))
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/** 从 nav / ncx 提取标题映射 href -> title */
function parseNavTitles(navXml: string, navDir: string): Map<string, string> {
  const map = new Map<string, string>()
  const contentLinks = [...navXml.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
  for (const m of contentLinks) {
    const href = resolvePath(navDir, m[1])
    const title = stripHtml(m[2]).trim()
    if (href && title) map.set(href, title)
  }
  const navPoints = [...navXml.matchAll(/<navPoint[\s\S]*?<\/navPoint>/gi)]
  for (const block of navPoints) {
    const label = block[0].match(/<navLabel>[\s\S]*?<text[^>]*>([\s\S]*?)<\/text>/i)
    const src = block[0].match(/<content\b[^>]*src=["']([^"']+)["']/i)
    if (label && src) {
      const href = resolvePath(navDir, src[1])
      const title = stripHtml(label[1]).trim()
      if (href && title) map.set(href, title)
    }
  }
  return map
}

function titleFromPath(path: string, index: number) {
  const base = path.split('/').pop()?.replace(/\.[^.]+$/, '') || ''
  if (base && !/^(chapter|ch|part|section|item)?_?\d+$/i.test(base)) {
    return decodeURIComponent(base)
  }
  return `第 ${index + 1} 章`
}

export async function parseEpub(
  data: ArrayBuffer,
  filename?: string,
  onProgress?: (p: EpubParseProgress) => void,
): Promise<ParsedEbook> {
  onProgress?.({ phase: 'unzip', current: 0, total: 1 })
  await yieldToMain()

  // 只解析 ZIP 目录，正文按需解压；跳过图片等二进制可减少内存压力
  const zip = await JSZip.loadAsync(data, {
    createFolders: false,
  })
  const zipIndex = buildZipIndex(zip)
  onProgress?.({ phase: 'unzip', current: 1, total: 1 })
  await yieldToMain()

  const containerXml = await readZipText(zipIndex, 'META-INF/container.xml')
  if (!containerXml) throw new Error('无效的 EPUB：缺少 container.xml')

  const rootfile = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1]
  if (!rootfile) throw new Error('无效的 EPUB：找不到内容清单')

  const opfPath = rootfile.replace(/\\/g, '/')
  const opfDir = dirname(opfPath)
  const opfXml = await readZipText(zipIndex, opfPath)
  if (!opfXml) throw new Error('无效的 EPUB：无法读取 OPF')

  const title =
    stripHtml(opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || '') ||
    filename?.replace(/\.epub$/i, '') ||
    '未命名书籍'

  const author =
    stripHtml(opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1] || '') || '未知作者'

  const manifest = new Map<string, { href: string; type: string }>()
  const manifestBlock = opfXml.match(/<manifest[\s\S]*?<\/manifest>/i)?.[0] || ''
  for (const m of manifestBlock.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], 'id')
    const href = attr(m[0], 'href')
    const type = attr(m[0], 'media-type') || ''
    if (id && href) {
      manifest.set(id, { href: resolvePath(opfDir, href), type })
    }
  }

  const spineIds: string[] = []
  const spineBlock = opfXml.match(/<spine[\s\S]*?<\/spine>/i)?.[0] || ''
  for (const m of spineBlock.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(m[0], 'idref')
    if (idref) spineIds.push(idref)
  }

  let titleMap = new Map<string, string>()
  let navHref: string | null = null
  for (const m of manifestBlock.matchAll(/<item\b[^>]*>/gi)) {
    const props = attr(m[0], 'properties') || ''
    const href = attr(m[0], 'href')
    if (href && /\bnav\b/i.test(props)) {
      navHref = resolvePath(opfDir, href)
      break
    }
  }
  if (!navHref) {
    const ncx = [...manifest.values()].find((v) => v.type.includes('ncx') || v.href.endsWith('.ncx'))
    if (ncx) navHref = ncx.href
  }
  if (navHref) {
    const navXml = await readZipText(zipIndex, navHref)
    if (navXml) titleMap = parseNavTitles(navXml, dirname(navHref))
  }

  const chapters: Omit<Chapter, 'id'>[] = []
  let cursor = 0
  const total = spineIds.length

  for (let i = 0; i < spineIds.length; i++) {
    if (i % 2 === 0) {
      onProgress?.({ phase: 'chapters', current: i, total })
      await yieldToMain()
    }

    const item = manifest.get(spineIds[i])
    if (!item) continue
    if (item.type && !/html|xml|svg/i.test(item.type) && !/\.x?html?$/i.test(item.href)) continue

    // 跳过封面图等非文本；只读 xhtml/html
    if (/\.(jpe?g|png|gif|webp|svg|ttf|otf|woff2?|css|mp3|mp4)$/i.test(item.href)) continue

    const html = await readZipText(zipIndex, item.href)
    if (!html) continue
    const raw = extractBody(html)
    const text = stripHtml(raw)
    if (!text || text.length < 2) continue

    const heading = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
    const fromNav = titleMap.get(item.href) || titleMap.get(item.href.split('#')[0])
    const chapterTitle =
      fromNav ||
      (heading ? stripHtml(heading[1]).trim() : '') ||
      titleFromPath(item.href, chapters.length)

    chapters.push({
      title: chapterTitle,
      startIndex: cursor,
      content: text,
    })
    cursor += text.length + 2
  }

  onProgress?.({ phase: 'chapters', current: total, total })

  if (chapters.length === 0) {
    throw new Error('未能从 EPUB 中提取到正文，请换一本试试')
  }

  // 不拼接全书正文，避免大书内存翻倍
  return { title, author, content: '', chapters }
}
