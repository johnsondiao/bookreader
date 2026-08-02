import JSZip from 'jszip'
import type { Chapter, TocEntry } from '../types'

export interface ParsedEbook {
  title: string
  author: string
  content: string
  chapters: Omit<Chapter, 'id'>[]
  toc: Omit<TocEntry, 'id' | 'chapterId'>[]
}

export type EpubParseProgress = {
  phase: 'unzip' | 'chapters'
  current: number
  total: number
}

type RawTocNode = {
  title: string
  href: string
  children: RawTocNode[]
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

function pathOnly(href: string) {
  return href.split('#')[0].replace(/^\.\//, '').replace(/\\/g, '/')
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

function flattenToc(nodes: RawTocNode[], level = 0): Omit<TocEntry, 'id' | 'chapterId'>[] {
  const out: Omit<TocEntry, 'id' | 'chapterId'>[] = []
  for (const n of nodes) {
    out.push({ title: n.title, level, href: n.href })
    if (n.children.length) out.push(...flattenToc(n.children, level + 1))
  }
  return out
}

/** EPUB3 nav：解析层级 ol/li */
function parseEpub3Nav(navXml: string, navDir: string): RawTocNode[] {
  try {
    const doc = new DOMParser().parseFromString(navXml, 'application/xhtml+xml')
    const navs = [...doc.querySelectorAll('nav')]
    const tocNav =
      navs.find((n) => {
        const t = (n.getAttribute('epub:type') || n.getAttribute('type') || '').toLowerCase()
        return t.includes('toc')
      }) || navs[0]
    if (!tocNav) return []

    const walkOl = (ol: Element): RawTocNode[] => {
      const items: RawTocNode[] = []
      for (const li of [...ol.children].filter((c) => c.tagName.toLowerCase() === 'li')) {
        const a = li.querySelector(':scope > a, :scope > span > a')
        const nested = li.querySelector(':scope > ol')
        const hrefRaw = a?.getAttribute('href') || ''
        const title = (a?.textContent || li.textContent || '').replace(/\s+/g, ' ').trim()
        if (!title) continue
        const href = hrefRaw ? resolvePath(navDir, hrefRaw) : ''
        items.push({
          title,
          href,
          children: nested ? walkOl(nested) : [],
        })
      }
      return items
    }

    const rootOl = tocNav.querySelector('ol')
    if (rootOl) return walkOl(rootOl)

    // 兜底：扁平 a 链接
    return [...tocNav.querySelectorAll('a[href]')].map((a) => ({
      title: (a.textContent || '').replace(/\s+/g, ' ').trim(),
      href: resolvePath(navDir, a.getAttribute('href') || ''),
      children: [],
    })).filter((n) => n.title)
  } catch {
    return []
  }
}

/** EPUB2 NCX：嵌套 navPoint */
function parseNcx(ncxXml: string, navDir: string): RawTocNode[] {
  try {
    const doc = new DOMParser().parseFromString(ncxXml, 'application/xml')
    const walk = (parent: Element): RawTocNode[] => {
      const points = [...parent.children].filter((c) => c.tagName.toLowerCase() === 'navpoint')
      return points.map((np) => {
        const label =
          np.querySelector('navLabel text, navlabel text')?.textContent?.replace(/\s+/g, ' ').trim() ||
          '未命名'
        const src = np.querySelector('content')?.getAttribute('src') || ''
        return {
          title: label,
          href: src ? resolvePath(navDir, src) : '',
          children: walk(np),
        }
      })
    }
    const navMap = doc.querySelector('navMap, navmap')
    return navMap ? walk(navMap) : []
  } catch {
    return []
  }
}

function titleFromPath(path: string, index: number) {
  const base = path.split('/').pop()?.replace(/\.[^.]+$/, '') || ''
  if (base && !/^(chapter|ch|part|section|item)?_?\d+$/i.test(base)) {
    try {
      return decodeURIComponent(base)
    } catch {
      return base
    }
  }
  return `第 ${index + 1} 章`
}

/** 将目录 href 关联到正文章节 id（按文件路径匹配） */
export function bindTocToChapters(
  toc: Omit<TocEntry, 'id' | 'chapterId'>[],
  chapters: { id: string; href?: string; title: string }[],
): TocEntry[] {
  const byHref = new Map<string, string>()
  chapters.forEach((c) => {
    if (c.href) byHref.set(pathOnly(c.href).toLowerCase(), c.id)
  })

  return toc.map((t, i) => {
    const key = pathOnly(t.href).toLowerCase()
    let chapterId = byHref.get(key) || null
    // 模糊：仅文件名
    if (!chapterId && key) {
      const base = key.split('/').pop() || ''
      const hit = chapters.find((c) => (c.href || '').toLowerCase().endsWith('/' + base) || pathOnly(c.href || '').toLowerCase() === base)
      chapterId = hit?.id || null
    }
    return {
      id: `toc-${i}`,
      title: t.title,
      level: t.level,
      href: t.href,
      chapterId,
    }
  })
}

/** TXT / 无 nav 时：由章节生成扁平目录 */
export function tocFromChapters(chapters: { id: string; title: string; href?: string }[]): TocEntry[] {
  return chapters.map((c, i) => ({
    id: `toc-${i}`,
    title: c.title,
    level: 0,
    chapterId: c.id,
    href: c.href || '',
  }))
}

export async function parseEpub(
  data: ArrayBuffer,
  filename?: string,
  onProgress?: (p: EpubParseProgress) => void,
): Promise<ParsedEbook> {
  onProgress?.({ phase: 'unzip', current: 0, total: 1 })
  await yieldToMain()

  const zip = await JSZip.loadAsync(data, { createFolders: false })
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

  const manifest = new Map<string, { href: string; type: string; props: string }>()
  const manifestBlock = opfXml.match(/<manifest[\s\S]*?<\/manifest>/i)?.[0] || ''
  for (const m of manifestBlock.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], 'id')
    const href = attr(m[0], 'href')
    const type = attr(m[0], 'media-type') || ''
    const props = attr(m[0], 'properties') || ''
    if (id && href) {
      manifest.set(id, { href: resolvePath(opfDir, href), type, props })
    }
  }

  const spineIds: string[] = []
  const spineBlock = opfXml.match(/<spine[\s\S]*?<\/spine>/i)?.[0] || ''
  for (const m of spineBlock.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(m[0], 'idref')
    if (idref) spineIds.push(idref)
  }

  // —— 解析真正的层级目录（优先 EPUB3 nav，其次 NCX）——
  let rawToc: RawTocNode[] = []
  let navHref: string | null = null
  for (const item of manifest.values()) {
    if (/\bnav\b/i.test(item.props)) {
      navHref = item.href
      break
    }
  }
  if (navHref) {
    const navXml = await readZipText(zipIndex, navHref)
    if (navXml) rawToc = parseEpub3Nav(navXml, dirname(navHref))
  }
  if (rawToc.length === 0) {
    const ncx = [...manifest.values()].find((v) => v.type.includes('ncx') || v.href.endsWith('.ncx'))
    if (ncx) {
      const ncxXml = await readZipText(zipIndex, ncx.href)
      if (ncxXml) rawToc = parseNcx(ncxXml, dirname(ncx.href))
    }
  }

  const titleByHref = new Map<string, string>()
  const walkTitles = (nodes: RawTocNode[]) => {
    for (const n of nodes) {
      if (n.href && n.title) titleByHref.set(pathOnly(n.href).toLowerCase(), n.title)
      walkTitles(n.children)
    }
  }
  walkTitles(rawToc)

  const chapters: Omit<Chapter, 'id'>[] = []
  let cursor = 0
  const total = spineIds.length
  const navPath = navHref ? pathOnly(navHref).toLowerCase() : ''

  for (let i = 0; i < spineIds.length; i++) {
    if (i % 2 === 0) {
      onProgress?.({ phase: 'chapters', current: i, total })
      await yieldToMain()
    }

    const item = manifest.get(spineIds[i])
    if (!item) continue
    if (item.type && !/html|xml|svg/i.test(item.type) && !/\.x?html?$/i.test(item.href)) continue
    if (/\.(jpe?g|png|gif|webp|svg|ttf|otf|woff2?|css|mp3|mp4)$/i.test(item.href)) continue
    // 跳过导航文档本身（目录页不是正文）
    if (/\bnav\b/i.test(item.props) || pathOnly(item.href).toLowerCase() === navPath) continue

    const html = await readZipText(zipIndex, item.href)
    if (!html) continue
    const raw = extractBody(html)
    const text = stripHtml(raw)
    if (!text || text.length < 2) continue

    const heading = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
    const fromNav = titleByHref.get(pathOnly(item.href).toLowerCase())
    const chapterTitle =
      fromNav ||
      (heading ? stripHtml(heading[1]).trim() : '') ||
      titleFromPath(item.href, chapters.length)

    chapters.push({
      title: chapterTitle,
      startIndex: cursor,
      content: text,
      href: item.href,
    })
    cursor += text.length + 2
  }

  onProgress?.({ phase: 'chapters', current: total, total })

  if (chapters.length === 0) {
    throw new Error('未能从 EPUB 中提取到正文，请换一本试试')
  }

  let toc = flattenToc(rawToc)
  // 无有效目录时回退为章节列表
  if (toc.length === 0) {
    toc = chapters.map((c) => ({
      title: c.title,
      level: 0,
      href: c.href || '',
    }))
  }

  return { title, author, content: '', chapters, toc }
}
