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
import { Directory, Filesystem } from '@capacitor/filesystem'

const BOOKS_DIR = 'LangyueReader/books'
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
