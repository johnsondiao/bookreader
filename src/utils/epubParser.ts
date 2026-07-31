import JSZip from 'jszip'
import type { Chapter } from '../types'

export interface ParsedEbook {
  title: string
  author: string
  content: string
  chapters: Omit<Chapter, 'id'>[]
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

function findZipFile(zip: JSZip, path: string) {
  const normalized = path.replace(/^\.\//, '')
  return (
    zip.file(normalized) ||
    zip.file(decodeURIComponent(normalized)) ||
    Object.values(zip.files).find((f) => !f.dir && f.name.replace(/\\/g, '/') === normalized) ||
    null
  )
}

async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const file = findZipFile(zip, path)
  if (!file) return null
  return file.async('text')
}

/** 从 nav / ncx 提取标题映射 href -> title */
function parseNavTitles(navXml: string, navDir: string): Map<string, string> {
  const map = new Map<string, string>()
  // EPUB3 nav
  const contentLinks = [...navXml.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
  for (const m of contentLinks) {
    const href = resolvePath(navDir, m[1])
    const title = stripHtml(m[2]).trim()
    if (href && title) map.set(href, title)
  }
  // EPUB2 NCX
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

export async function parseEpub(data: ArrayBuffer, filename?: string): Promise<ParsedEbook> {
  const zip = await JSZip.loadAsync(data)

  const containerXml = await readZipText(zip, 'META-INF/container.xml')
  if (!containerXml) throw new Error('无效的 EPUB：缺少 container.xml')

  const rootfile = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1]
  if (!rootfile) throw new Error('无效的 EPUB：找不到内容清单')

  const opfPath = rootfile.replace(/\\/g, '/')
  const opfDir = dirname(opfPath)
  const opfXml = await readZipText(zip, opfPath)
  if (!opfXml) throw new Error('无效的 EPUB：无法读取 OPF')

  const title =
    stripHtml(opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || '') ||
    filename?.replace(/\.epub$/i, '') ||
    '未命名书籍'

  const author =
    stripHtml(opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1] || '') || '未知作者'

  // manifest id -> href + media-type
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

  // spine order
  const spineIds: string[] = []
  const spineBlock = opfXml.match(/<spine[\s\S]*?<\/spine>/i)?.[0] || ''
  for (const m of spineBlock.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(m[0], 'idref')
    if (idref) spineIds.push(idref)
  }

  // nav titles
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
    const navXml = await readZipText(zip, navHref)
    if (navXml) titleMap = parseNavTitles(navXml, dirname(navHref))
  }

  const chapters: Omit<Chapter, 'id'>[] = []
  let cursor = 0

  for (let i = 0; i < spineIds.length; i++) {
    const item = manifest.get(spineIds[i])
    if (!item) continue
    if (item.type && !/html|xml|svg/i.test(item.type) && !/\.x?html?$/i.test(item.href)) continue

    const html = await readZipText(zip, item.href)
    if (!html) continue
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
    const raw = bodyMatch ? bodyMatch[1] : html
    const text = stripHtml(raw)
    if (!text || text.length < 2) continue

    // skip obvious cover/toc-only short pages without paragraphs
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

  if (chapters.length === 0) {
    throw new Error('未能从 EPUB 中提取到正文，请换一本试试')
  }

  const content = chapters.map((c) => `${c.title}\n\n${c.content}`).join('\n\n')

  return { title, author, content, chapters }
}
