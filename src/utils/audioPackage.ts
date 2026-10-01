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

/**
 * 导入进度回调。
 *
 * phase 语义：
 *  - read     读取压缩包字节（current/total = 已读/总字节）
 *  - manifest 解析中央目录与 manifest（total 无意义）
 *  - scan     扫描候选目录（current/total = 已检查/总目录数）
 *  - unzip    解压单章 mp3（current/total = 第 n/总章数）
 *  - write    落盘单章 mp3（current/total = 第 n/总章数）
 *  - move     移动/复制目录（total<=0 表示不确定进度）
 */
export interface ImportProgress {
  phase: 'read' | 'manifest' | 'scan' | 'unzip' | 'write' | 'move'
  current: number
  total: number
  detail: string
}
export type ProgressFn = (p: ImportProgress) => void

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 超过该体积的 zip 建议改用「文件夹导入」（整体解压会占满手机内存） */
export const ZIP_IN_MEMORY_LIMIT = 200 * 1024 * 1024

/**
 * 已打开的音频包：只解析了中央目录与 manifest，mp3 按需逐章解压。
 *
 * 关键设计：不再一次性把所有 mp3 解进内存（1.2G 的包会直接 OOM），
 * 而是让调用方「读一章 → 写一章 → 释放」，内存峰值仅为一章大小。
 */
export interface OpenedAudioPackage {
  /** 压缩包原始字节数 */
  sizeBytes: number
  manifest: AudioManifest
  /** 包内含的源文件（仅元信息，内容按需读取） */
  source: { name: string; ext: 'epub' | 'txt' } | null
  /** manifest 中确实存在对应 mp3 文件的章节 id */
  audioChapterIds: string[]
  readSource: () => Promise<Uint8Array | null>
  readChapter: (chapterId: string) => Promise<Uint8Array | null>
}

/** 带进度地读取文件字节（FileReader 分片读取，可上报已读字节数） */
function readFileWithProgress(file: File, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const fr = new FileReader()
    fr.onprogress = (e) => {
      onProgress?.({
        phase: 'read',
        current: e.loaded,
        total: e.lengthComputable ? e.total : file.size,
        detail: `读取压缩包 ${formatBytes(e.loaded)}${e.lengthComputable ? ` / ${formatBytes(e.total)}` : ''}`,
      })
    }
    fr.onload = () => resolve(fr.result as ArrayBuffer)
    fr.onerror = () => reject(fr.error ?? new Error('读取压缩包失败'))
    fr.readAsArrayBuffer(file)
  })
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

/**
 * 打开音频包：解析中央目录与 manifest，返回按需读取句柄（不解压 mp3）。
 *
 * 相比一次性全解，内存占用从「整包大小」降到「压缩包本身 + 单章大小」，
 * 1.2G 的包也不会再把手机 WebView 拖死。
 */
export async function openAudioPackage(
  file: File | ArrayBuffer,
  onProgress?: ProgressFn,
): Promise<OpenedAudioPackage> {
  const sizeBytes = file instanceof ArrayBuffer ? file.byteLength : file.size
  const data = file instanceof ArrayBuffer ? file : await readFileWithProgress(file, onProgress)

  onProgress?.({
    phase: 'manifest',
    current: 0,
    total: 0,
    detail: `解析压缩包目录（${formatBytes(sizeBytes)}）…`,
  })
  const zip = await JSZip.loadAsync(data, { createFolders: false })

  // 1. manifest.json
  const manifestEntry = zip.file('manifest.json')
  if (!manifestEntry) throw new Error('不是音频包：缺少 manifest.json')
  const manifestRaw = JSON.parse(await manifestEntry.async('text')) as unknown
  const manifest = parseAudioManifest(manifestRaw)

  // 2. 源文件 book/source.*（只记元信息，内容按需读）
  let source: OpenedAudioPackage['source'] = null
  let sourceEntry: JSZip.JSZipObject | null = null
  for (const ext of ['epub', 'txt'] as const) {
    const name = `book/source.${ext}`
    const e = zip.file(name)
    if (e) {
      source = { name, ext }
      sourceEntry = e
      break
    }
  }

  // 3. 逐章探测 mp3 是否存在（不解压内容）
  const chapterEntry = new Map<string, JSZip.JSZipObject>()
  for (const ch of manifest.chapters) {
    const id = normalizeChapterId(ch.id)
    if (!id) continue
    const e = zip.file(`audio/${id}.mp3`) ?? zip.file(`audio/${encodeURIComponent(id)}.mp3`)
    if (e) chapterEntry.set(id, e)
  }
  const audioChapterIds = [...chapterEntry.keys()]

  return {
    sizeBytes,
    manifest,
    source,
    audioChapterIds,
    readSource: async () => (sourceEntry ? await sourceEntry.async('uint8array') : null),
    readChapter: async (chapterId: string) => {
      const e = chapterEntry.get(chapterId)
      return e ? await e.async('uint8array') : null
    },
  }
}

/** 从 zip 文件解包音频包（一次性全解，仅供小包/测试使用；大包请用 openAudioPackage） */
export async function parseAudioPackage(file: File | ArrayBuffer, onProgress?: ProgressFn): Promise<ParsedAudioPackage> {
  const opened = await openAudioPackage(file, onProgress)

  const sourceBytes = await opened.readSource()
  const source: ParsedAudioPackage['source'] =
    sourceBytes && opened.source ? { name: opened.source.name, ext: opened.source.ext, bytes: sourceBytes } : null

  const audio = new Map<string, Uint8Array>()
  const total = opened.audioChapterIds.length
  for (let i = 0; i < total; i++) {
    const id = opened.audioChapterIds[i]
    const bytes = await opened.readChapter(id)
    if (bytes) audio.set(id, bytes)
    onProgress?.({
      phase: 'unzip',
      current: i + 1,
      total,
      detail: `解压第 ${i + 1} / ${total} 章`,
    })
  }

  return { manifest: opened.manifest, source, audio }
}
