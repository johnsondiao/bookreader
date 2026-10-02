/**
 * 音频包文件存储：把 PC 导出的章节 mp3 与源文件落到磁盘。
 *
 * 存储位置（Capacitor `Directory.Data` = App 私有 files 目录，**零权限**）：
 *   files/LangyueReader/books/{bookId}/audio/{chapterId}.mp3
 *   files/LangyueReader/books/{bookId}/source.{ext}
 *
 * 为什么不用公共 Documents：
 *   Android 11+ 写入公共目录必须申请「所有文件访问权限」（MANAGE_EXTERNAL_STORAGE），
 *   这属敏感权限、容易被系统拒绝，一旦未授权就 `EACCES (Permission denied)` 写入失败。
 *   私有目录由 App 全权管理，无需任何运行时权限，读写永远可用。
 *
 * 导入分两阶段（先解压到暂存目录，再整体导入）：
 *   ① 解压：zip 逐章流式解压 → files/LangyueReader/staging/{bookId}/
 *   ② 导入：staging 逐章 rename → books/{bookId}/（同分区零拷贝），完成后清空 staging
 *   这样即使中途失败，正式书架目录也不会留下半本书。
 *
 * 非原生环境（网页预览）无文件系统：mp3 以 Blob URL 存内存，仅当次会话可播放。
 */
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { formatBytes, type ProgressFn } from './audioPackage'

const ROOT = 'LangyueReader'
const BOOKS_DIR = `${ROOT}/books`
const STAGING_DIR = `${ROOT}/staging`
/** App 私有目录：零权限，Android / iOS 通用 */
const STORAGE_DIR: Directory = Directory.Data

function bookDir(bookId: string): string {
  return `${BOOKS_DIR}/${bookId}`
}
function audioPath(bookId: string, chapterId: string): string {
  return `${bookDir(bookId)}/audio/${chapterId}.mp3`
}
function stagingBookDir(bookId: string): string {
  return `${STAGING_DIR}/${bookId}`
}

let fsReady: boolean | null = null

/** 确保私有根目录可用（幂等，结果缓存） */
async function ensureAvailable(): Promise<boolean> {
  if (fsReady !== null) return fsReady
  if (!Capacitor.isNativePlatform()) {
    fsReady = false
    return false
  }
  try {
    await Filesystem.mkdir({ path: BOOKS_DIR, directory: STORAGE_DIR, recursive: true })
    fsReady = true
  } catch (err) {
    fsReady = /already exists/i.test((err as Error)?.message ?? String(err))
  }
  return fsReady
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

/** 判断某文件是否存在 */
async function exists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: STORAGE_DIR })
    return true
  } catch {
    return false
  }
}

// ───────────────────────── 阶段一：解压到暂存目录 ─────────────────────────

/** 开始一次导入：清空该书上次可能残留的暂存目录，并建好 audio 子目录 */
export async function resetStaging(bookId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  if (!(await ensureAvailable())) throw new Error('App 存储目录不可用，请重启应用后重试')
  try {
    await Filesystem.rmdir({ path: stagingBookDir(bookId), directory: STORAGE_DIR, recursive: true })
  } catch {
    /* 目录不存在 */
  }
  await Filesystem.mkdir({ path: `${stagingBookDir(bookId)}/audio`, directory: STORAGE_DIR, recursive: true })
}

/** 把解压出的一章 mp3 写入暂存目录（网页预览直接存 Blob URL） */
export async function writeStagedChapter(bookId: string, chapterId: string, bytes: Uint8Array): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const old = webBlobUrls.get(`${bookId}/${chapterId}`)
    if (old) URL.revokeObjectURL(old)
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/mpeg' })
    webBlobUrls.set(`${bookId}/${chapterId}`, URL.createObjectURL(blob))
    return
  }
  if (!(await ensureAvailable())) throw new Error('App 存储目录不可用，请重启应用后重试')
  await Filesystem.writeFile({
    path: `${stagingBookDir(bookId)}/audio/${chapterId}.mp3`,
    directory: STORAGE_DIR,
    data: bytesToBase64(bytes),
    recursive: true,
  })
}

/** 暂存源文件（可选，供日后纯文本重读） */
export async function writeStagedSource(bookId: string, ext: 'epub' | 'txt', bytes: Uint8Array): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  if (!(await ensureAvailable())) return
  await Filesystem.writeFile({
    path: `${stagingBookDir(bookId)}/source.${ext}`,
    directory: STORAGE_DIR,
    data: bytesToBase64(bytes),
    recursive: true,
  })
}

// ───────────────────────── 阶段二：暂存目录 → 正式书架 ─────────────────────────

/**
 * 把暂存目录里的成品逐章搬进正式书架目录。
 *
 * 同分区 rename 零拷贝（1.1G 也瞬间完成，`onProgress` 会快速走完）；
 * 极端情况下 rename 失败（跨分区等）则回退为「读取 → 写入 → 删源」。
 */
export async function commitStaging(bookId: string, chapterIds: string[], onProgress?: ProgressFn): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  if (!(await ensureAvailable())) throw new Error('App 存储目录不可用，请重启应用后重试')

  await Filesystem.mkdir({ path: `${bookDir(bookId)}/audio`, directory: STORAGE_DIR, recursive: true }).catch(() => {
    /* 已存在 */
  })

  const total = chapterIds.length
  for (let i = 0; i < total; i++) {
    const ch = chapterIds[i]
    const from = `${stagingBookDir(bookId)}/audio/${ch}.mp3`
    const to = audioPath(bookId, ch)
    if (!(await exists(from))) {
      onProgress?.({ phase: 'write', current: i + 1, total, detail: `第 ${i + 1} / ${total} 章无音频，跳过` })
      continue
    }
    try {
      await Filesystem.rename({ from, to, directory: STORAGE_DIR, toDirectory: STORAGE_DIR })
    } catch {
      const r = await Filesystem.readFile({ path: from, directory: STORAGE_DIR })
      await Filesystem.writeFile({ path: to, directory: STORAGE_DIR, data: r.data as string, recursive: true })
      try {
        await Filesystem.deleteFile({ path: from, directory: STORAGE_DIR })
      } catch {
        /* 删源失败不影响导入 */
      }
    }
    onProgress?.({ phase: 'write', current: i + 1, total, detail: `导入第 ${i + 1} / ${total} 章` })
  }

  // 源文件（可选）
  for (const ext of ['epub', 'txt'] as const) {
    const sFrom = `${stagingBookDir(bookId)}/source.${ext}`
    if (!(await exists(sFrom))) continue
    try {
      await Filesystem.rename({
        from: sFrom,
        to: `${bookDir(bookId)}/source.${ext}`,
        directory: STORAGE_DIR,
        toDirectory: STORAGE_DIR,
      })
    } catch {
      /* 源文件搬运失败不致命 */
    }
    break
  }
}

/** 清理暂存目录（导入完成或失败后调用） */
export async function clearStaging(bookId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    await Filesystem.rmdir({ path: stagingBookDir(bookId), directory: STORAGE_DIR, recursive: true })
  } catch {
    /* 目录不存在 */
  }
}

// ───────────────────────── 播放与清理 ─────────────────────────

/** 取某章 mp3 的可播放 URL（原生 → convertFileSrc；网页 → Blob URL） */
export async function getChapterAudioUrl(bookId: string, chapterId: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) {
    return webBlobUrls.get(`${bookId}/${chapterId}`) ?? null
  }
  if (!(await ensureAvailable())) return null
  try {
    const uri = await Filesystem.getUri({ path: audioPath(bookId, chapterId), directory: STORAGE_DIR })
    return Capacitor.convertFileSrc(uri.uri)
  } catch {
    return null
  }
}

/** 估算某本书已落盘音频占用的空间 */
export async function getBookAudioSize(bookId: string): Promise<number> {
  if (!Capacitor.isNativePlatform()) return 0
  if (!(await ensureAvailable())) return 0
  try {
    const r = await Filesystem.readdir({ path: `${bookDir(bookId)}/audio`, directory: STORAGE_DIR })
    return r.files.reduce((n, f) => n + (f.size ?? 0), 0)
  } catch {
    return 0
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

export { formatBytes }
