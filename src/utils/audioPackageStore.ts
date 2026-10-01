/**
 * 音频包文件存储：把 PC 导出的章节 mp3 与源文件落到磁盘。
 *
 * 存储位置（Capacitor `Directory.Documents`，卸载重装不丢）：
 *   /storage/emulated/0/Documents/LangyueReader/books/{bookId}/audio/{chapterId}.mp3
 *   /storage/emulated/0/Documents/LangyueReader/books/{bookId}/source.{ext}
 *
 * 非原生环境（网页预览）无文件系统：mp3 以 Blob URL 存内存，仅当次会话可播放。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { AudioManifest } from '../types'
import { formatBytes, parseAudioManifest, type ProgressFn } from './audioPackage'

const BOOKS_DIR = 'LangyueReader/books'
/** 文件夹导入的约定目录：用户手动解压到这里，App 扫描后原地接管 */
export const INBOX_DIR = 'LangyueReader/inbox'
const STORAGE_DIR: Directory = Directory.Documents

/** 原生自定义插件（MainActivity 注册）：「所有文件访问权限」检测与跳转 */
interface AllFilesAccessPlugin {
  isManager(): Promise<{ granted: boolean }>
  requestManager(): Promise<{ granted: boolean; openedSettings?: boolean }>
}
const AllFilesAccess = registerPlugin<AllFilesAccessPlugin>('AllFilesAccess')

let cachedAvailable: boolean | null = null
let lastError: string | null = null

/** Android 11+ 读公共 Documents 需授「所有文件访问权限」（非原生环境视为已授予） */
export async function isAllFilesAccessGranted(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return true
  try {
    const r = await AllFilesAccess.isManager()
    return !!r.granted
  } catch {
    return true
  }
}

export async function requestAllFilesAccess(): Promise<{ granted: boolean; openedSettings: boolean }> {
  try {
    const r = await AllFilesAccess.requestManager()
    return { granted: !!r.granted, openedSettings: !!r.openedSettings }
  } catch {
    return { granted: false, openedSettings: false }
  }
}

export function getLastFsError(): string | null {
  return lastError
}

function bookDir(bookId: string): string {
  return `${BOOKS_DIR}/${bookId}`
}
function audioPath(bookId: string, chapterId: string): string {
  return `${bookDir(bookId)}/audio/${chapterId}.mp3`
}

/** 确保音频目录可用（幂等） */
async function ensureAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable
  if (!Capacitor.isNativePlatform()) {
    cachedAvailable = false
    return false
  }
  try {
    await Filesystem.mkdir({ path: BOOKS_DIR, directory: STORAGE_DIR, recursive: true })
    cachedAvailable = true
    lastError = null
    return true
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    if (/already exists/i.test(msg)) {
      cachedAvailable = true
      lastError = null
      return true
    }
    lastError = msg
    cachedAvailable = false
    return false
  }
}

/** 非原生环境的 Blob URL 缓存（仅当次会话有效） */
const webBlobUrls = new Map<string, string>()

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let s = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/** 保存某章 mp3（原生写文件；网页存 Blob URL） */
export async function saveChapterAudio(bookId: string, chapterId: string, bytes: Uint8Array): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/mpeg' })
    webBlobUrls.set(`${bookId}/${chapterId}`, URL.createObjectURL(blob))
    return
  }
  if (!(await ensureAvailable())) {
    throw new Error('文件系统不可用' + (lastError ? `：${lastError}` : ''))
  }
  await Filesystem.writeFile({
    path: audioPath(bookId, chapterId),
    directory: STORAGE_DIR,
    data: bytesToBase64(bytes),
    recursive: true,
  })
}

/** 保存源文件（可选） */
export async function saveBookSource(bookId: string, ext: 'epub' | 'txt', bytes: Uint8Array): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  if (!(await ensureAvailable())) return
  await Filesystem.writeFile({
    path: `${bookDir(bookId)}/source.${ext}`,
    directory: STORAGE_DIR,
    data: bytesToBase64(bytes),
    recursive: true,
  })
}

/** 取某章 mp3 的可播放 URL（原生 → convertFileSrc；网页 → Blob URL） */
export async function getChapterAudioUrl(bookId: string, chapterId: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) {
    return webBlobUrls.get(`${bookId}/${chapterId}`) ?? null
  }
  if (!(await ensureAvailable())) return null
  try {
    const uri = await Filesystem.getUri({
      path: audioPath(bookId, chapterId),
      directory: STORAGE_DIR,
    })
    return Capacitor.convertFileSrc(uri.uri)
  } catch (err) {
    lastError = (err as Error)?.message ?? String(err)
    return null
  }
}

// ─────────────────────────── 文件夹导入（备用方式） ───────────────────────────
//
// 主路径是 App 内直接导入 zip（见 audioPackage.ts 的流式逐章解压），用户无需手动解压。
// 本区块是备用路径：仅当用户已在别处解压好文件夹、想省去再解压一份空间时才用。
// 把解压出的文件夹放进 `Documents/LangyueReader/inbox/<任意名>/`
// （含 manifest.json、book/、audio/），App 扫描后**同分区 rename 原地接管**——秒级、不复制。

/** inbox 里扫描到的一个待导入包 */
export interface InboxCandidate {
  /** inbox 下的子目录名 */
  dirName: string
  /** 相对 Documents 的路径 */
  path: string
  manifest: AudioManifest
  /** 实际存在的 audio/*.mp3 文件数 */
  audioFileCount: number
  /** audio 目录总字节数 */
  sizeBytes: number
  /** manifest 声明的章节数 */
  expectedChapterCount: number
}

/** 读取文本文件（原生返回 string，网页可能返回 Blob） */
async function readTextFile(path: string): Promise<string> {
  const r = await Filesystem.readFile({ path, directory: STORAGE_DIR, encoding: Encoding.UTF8 })
  const data = r.data
  if (typeof data === 'string') return data
  return await (data as Blob).text()
}

/** 列出目录（目录不存在时返回空数组，不抛错） */
async function readdirSafe(path: string): Promise<{ name: string; type: string; size?: number }[]> {
  try {
    const r = await Filesystem.readdir({ path, directory: STORAGE_DIR })
    return r.files as { name: string; type: string; size?: number }[]
  } catch {
    return []
  }
}

/** 确保 inbox 目录存在，返回其展示用绝对路径 */
export async function ensureInboxDir(): Promise<string> {
  if (!Capacitor.isNativePlatform()) return ''
  if (await ensureAvailable()) {
    try {
      await Filesystem.mkdir({ path: INBOX_DIR, directory: STORAGE_DIR, recursive: true })
    } catch {
      /* 已存在 */
    }
    try {
      const uri = await Filesystem.getUri({ path: INBOX_DIR, directory: STORAGE_DIR })
      return uri.uri.replace(/^file:\/\//, '')
    } catch {
      return INBOX_DIR
    }
  }
  return INBOX_DIR
}

/**
 * 扫描 inbox 下的一级子目录，找出所有合法的音频包。
 * 目录不存在或为空时返回空数组（不抛错，由 UI 负责引导）。
 */
export async function scanInbox(onProgress?: ProgressFn): Promise<InboxCandidate[]> {
  if (!Capacitor.isNativePlatform()) return []
  if (!(await ensureAvailable())) {
    throw new Error('文件系统不可用' + (lastError ? `：${lastError}` : ''))
  }

  const entries = await readdirSafe(INBOX_DIR)
  const dirs = entries.filter((e) => e.type === 'directory')
  const out: InboxCandidate[] = []

  for (let i = 0; i < dirs.length; i++) {
    const name = dirs[i].name
    onProgress?.({
      phase: 'scan',
      current: i + 1,
      total: dirs.length,
      detail: `检查文件夹 ${name}（${i + 1} / ${dirs.length}）`,
    })

    const path = `${INBOX_DIR}/${name}`
    try {
      const text = await readTextFile(`${path}/manifest.json`)
      const manifest = parseAudioManifest(JSON.parse(text))

      let audioFileCount = 0
      let sizeBytes = 0
      const audioEntries = await readdirSafe(`${path}/audio`)
      for (const f of audioEntries) {
        if (f.type === 'file' && f.name.toLowerCase().endsWith('.mp3')) {
          audioFileCount++
          sizeBytes += f.size ?? 0
        }
      }
      out.push({
        dirName: name,
        path,
        manifest,
        audioFileCount,
        sizeBytes,
        expectedChapterCount: manifest.chapters.length,
      })
    } catch {
      /* 不是有效音频包（无 manifest.json / 校验失败），跳过 */
    }
  }

  return out
}

/** 递归复制目录（rename 失败时的兜底，逐文件上报进度） */
async function copyDirRecursive(from: string, to: string, onProgress?: ProgressFn, counter = { done: 0, total: 0 }): Promise<void> {
  const entries = await readdirSafe(from)
  for (const e of entries) {
    const src = `${from}/${e.name}`
    const dst = `${to}/${e.name}`
    if (e.type === 'directory') {
      await copyDirRecursive(src, dst, onProgress, counter)
    } else {
      const r = await Filesystem.readFile({ path: src, directory: STORAGE_DIR })
      await Filesystem.writeFile({ path: dst, directory: STORAGE_DIR, data: r.data as string, recursive: true })
      counter.done++
      onProgress?.({
        phase: 'move',
        current: counter.done,
        total: counter.total,
        detail: `复制文件 ${counter.done} / ${counter.total}（${e.name}）`,
      })
    }
  }
}

/** 统计目录下的文件总数（用于复制进度，尽力而为） */
async function countFiles(from: string): Promise<number> {
  const entries = await readdirSafe(from)
  let n = 0
  for (const e of entries) {
    if (e.type === 'directory') n += await countFiles(`${from}/${e.name}`)
    else n++
  }
  return n
}

/**
 * 把一个 inbox 候选包接管到 books/{bookId}/。
 *
 * 优先同分区 rename（零拷贝，1.2G 也是瞬间完成）；失败时回退逐文件复制。
 * 返回实际使用的模式，便于 UI 给出准确提示。
 */
export async function importInboxPackage(
  cand: InboxCandidate,
  bookId: string,
  onProgress?: ProgressFn,
): Promise<{ mode: 'move' | 'copy' }> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('网页预览不支持文件夹导入，请在 App 内操作')
  }
  if (!(await ensureAvailable())) {
    throw new Error('文件系统不可用' + (lastError ? `：${lastError}` : ''))
  }

  const to = bookDir(bookId)
  // 已存在同 id 的旧目录：先清掉，避免 rename 撞名/残留旧文件
  try {
    await Filesystem.rmdir({ path: to, directory: STORAGE_DIR, recursive: true })
  } catch {
    /* 目录不存在 */
  }

  onProgress?.({ phase: 'move', current: 0, total: 0, detail: '接管目录（同分区移动，不复制数据）…' })
  try {
    await Filesystem.rename({ from: cand.path, to, directory: STORAGE_DIR, toDirectory: STORAGE_DIR })
    onProgress?.({ phase: 'move', current: 1, total: 1, detail: '目录接管完成' })
    return { mode: 'move' }
  } catch (err) {
    lastError = (err as Error)?.message ?? String(err)
  }

  // 兜底：跨分区等原因 rename 失败 → 逐文件复制
  const total = await countFiles(cand.path)
  onProgress?.({ phase: 'move', current: 0, total, detail: `移动失败，改为复制 ${total} 个文件…` })
  await copyDirRecursive(cand.path, to, onProgress, { done: 0, total })
  // 复制完成后清理 inbox 源目录，避免下次扫描重复出现
  try {
    await Filesystem.rmdir({ path: cand.path, directory: STORAGE_DIR, recursive: true })
  } catch {
    /* 清理失败不影响导入 */
  }
  return { mode: 'copy' }
}

/** 估算某本书已落盘音频占用的空间（书架/详情展示用） */
export async function getBookAudioSize(bookId: string): Promise<number> {
  if (!Capacitor.isNativePlatform()) return 0
  if (!(await ensureAvailable())) return 0
  const audioDir = `${bookDir(bookId)}/audio`
  const files = await readdirSafe(audioDir)
  let total = 0
  for (const f of files) total += f.size ?? 0
  return total
}

export { formatBytes }

/** 删除某本书的全部音频文件（从书架移除时调用） */
export async function deleteBookAudio(bookId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    for (const key of [...webBlobUrls.keys()]) {
      if (key.startsWith(`${bookId}/`)) {
        const url = webBlobUrls.get(key)
        if (url) URL.revokeObjectURL(url)
        webBlobUrls.delete(key)
      }
    }
    return
  }
  if (!(await ensureAvailable())) return
  try {
    await Filesystem.rmdir({ path: bookDir(bookId), directory: STORAGE_DIR, recursive: true })
  } catch {
    /* 目录可能不存在 */
  }
}
