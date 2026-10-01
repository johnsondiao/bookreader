/**
 * 音频包（PC 端导出）解析与导入。
 *
 * 包结构（docs/audio-package-format.md）：
 *   {bookTitle}.langyue.zip
 *   ├── manifest.json
 *   ├── book/source.epub|txt   # 源电子书（可选）
 *   └── audio/{chapterId}.mp3  # 每章一个 mp3（正文段 + 注释段）
 *
 * 本模块职责：解包 → 校验 format/version → 解析 manifest → 提取源文件与各章 mp3 字节。
 * 不负责落盘（见 audioPackageStore.ts）与播放（见 audioPlayer.ts）。
 */
import JSZip from 'jszip'
import type { AudioManifest } from '../types'

export const AUDIO_PACKAGE_FORMAT = 'langyue-audiobook'
export const AUDIO_PACKAGE_VERSION = 1

/** 解包结果：manifest + 源文件 + 各章 mp3 字节（key = chapterId） */
export interface ParsedAudioPackage {
  manifest: AudioManifest
  /** 源文件内容（若包内含 book/source.*） */
  source: { name: string; ext: 'epub' | 'txt'; bytes: Uint8Array } | null
  /** chapterId → mp3 字节 */
  audio: Map<string, Uint8Array>
}

function normalizeChapterId(id: unknown): string | null {
  if (typeof id !== 'string' || !id) return null
  return id
}

/** 校验并规整 manifest，非法时抛错 */
export function parseAudioManifest(raw: unknown): AudioManifest {
  const m = raw as Partial<AudioManifest>
  if (!m || typeof m !== 'object') throw new Error('manifest.json 内容无效')
  if (m.format !== AUDIO_PACKAGE_FORMAT) {
    throw new Error(`不是朗阅音频包（format=${String(m.format)}），请确认文件来自 PC 端合成工作台`)
  }
  if (typeof m.version !== 'number' || m.version !== AUDIO_PACKAGE_VERSION) {
    throw new Error(`音频包版本不兼容（version=${String(m.version)}），请升级 App 或重新导出`)
  }
  if (!m.book || typeof m.book.title !== 'string') throw new Error('manifest 缺少书名')
  if (!Array.isArray(m.chapters)) throw new Error('manifest 缺少章节列表')

  const chapters: AudioManifest['chapters'] = []
  for (const raw of m.chapters) {
    const ch = raw as Partial<AudioManifest['chapters'][number]>
    if (!ch || typeof ch.id !== 'string') continue
    const sentences: AudioManifest['chapters'][number]['sentences'] = Array.isArray(ch.sentences)
      ? ch.sentences.map((s, i) => ({
          index: Number((s as { index?: unknown }).index ?? i),
          text: String((s as { text?: unknown }).text ?? ''),
          kind: 'text' as const,
          startMs: Number((s as { startMs?: unknown }).startMs) || 0,
          endMs: Number((s as { endMs?: unknown }).endMs) || 0,
          voiceStartMs: Number((s as { voiceStartMs?: unknown }).voiceStartMs) || Number((s as { startMs?: unknown }).startMs) || 0,
          voiceEndMs: Number((s as { voiceEndMs?: unknown }).voiceEndMs) || Number((s as { endMs?: unknown }).endMs) || 0,
          noteRef: Array.isArray((s as { noteRef?: unknown }).noteRef)
            ? ((s as { noteRef?: unknown }).noteRef as unknown[]).map(String)
            : undefined,
        }))
      : []
    const notes: AudioManifest['chapters'][number]['notes'] = Array.isArray(ch.notes)
      ? ch.notes.map((n, i) => ({
          id: String((n as { id?: unknown }).id ?? `n${i}`),
          index: Number((n as { index?: unknown }).index ?? i),
          text: String((n as { text?: unknown }).text ?? ''),
          kind: 'note' as const,
          startMs: Number((n as { startMs?: unknown }).startMs) || 0,
          endMs: Number((n as { endMs?: unknown }).endMs) || 0,
          voiceStartMs: Number((n as { voiceStartMs?: unknown }).voiceStartMs) || Number((n as { startMs?: unknown }).startMs) || 0,
          voiceEndMs: Number((n as { voiceEndMs?: unknown }).voiceEndMs) || Number((n as { endMs?: unknown }).endMs) || 0,
        }))
      : []
    chapters.push({
      id: ch.id,
      title: typeof ch.title === 'string' ? ch.title : ch.id,
      durationMs: Number(ch.durationMs) || 0,
      sentenceCount: Number(ch.sentenceCount) || 0,
      sentences,
      notes,
      notesDurationMs: Number(ch.notesDurationMs) || Number(ch.durationMs) || 0,
    })
  }

  if (chapters.length === 0) throw new Error('音频包内没有可导入的章节')

  const pkg = m.package ?? ({} as AudioManifest['package'])
  const chapterIds = Array.isArray(pkg.chapterIds)
    ? pkg.chapterIds.filter((x): x is string => typeof x === 'string')
    : chapters.map((c) => c.id)

  return {
    format: AUDIO_PACKAGE_FORMAT,
    version: AUDIO_PACKAGE_VERSION,
    generator: typeof m.generator === 'string' ? m.generator : undefined,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : undefined,
    package: {
      mode: pkg.mode === 'full' ? 'full' : 'partial',
      chapterIds,
      sourceChapterCount: Number(pkg.sourceChapterCount) || chapters.length,
      batch: typeof pkg.batch === 'number' ? pkg.batch : undefined,
    },
    book: {
      id: typeof m.book.id === 'string' && m.book.id ? m.book.id : `b-${m.book.title}`,
      title: m.book.title,
      author: typeof m.book.author === 'string' ? m.book.author : undefined,
      sourceFile: typeof m.book.sourceFile === 'string' ? m.book.sourceFile : '',
      sourceFormat: m.book.sourceFormat === 'txt' ? 'txt' : 'epub',
      voice: m.book.voice,
      noteVoice: m.book.noteVoice,
    },
    chapters,
    integrity: m.integrity,
  }
}

/** 从 zip 文件解包音频包（不落盘，纯解析） */
export async function parseAudioPackage(file: File | ArrayBuffer): Promise<ParsedAudioPackage> {
  const data = file instanceof ArrayBuffer ? file : await file.arrayBuffer()
  const zip = await JSZip.loadAsync(data, { createFolders: false })

  // 1. manifest.json
  const manifestEntry = zip.file('manifest.json')
  if (!manifestEntry) throw new Error('不是音频包：缺少 manifest.json')
  const manifestRaw = JSON.parse(await manifestEntry.async('text')) as unknown
  const manifest = parseAudioManifest(manifestRaw)

  // 2. 源文件 book/source.*
  let source: ParsedAudioPackage['source'] = null
  for (const ext of ['epub', 'txt'] as const) {
    const name = `book/source.${ext}`
    const e = zip.file(name)
    if (e) {
      source = { name, ext, bytes: await e.async('uint8array') }
      break
    }
  }

  // 3. 各章 mp3：audio/{chapterId}.mp3
  const audio = new Map<string, Uint8Array>()
  for (const ch of manifest.chapters) {
    const id = normalizeChapterId(ch.id)
    if (!id) continue
    const path = `audio/${id}.mp3`
    const e = zip.file(path) ?? zip.file(`audio/${encodeURIComponent(id)}.mp3`)
    if (e) {
      audio.set(id, await e.async('uint8array'))
    }
  }

  return { manifest, source, audio }
}
