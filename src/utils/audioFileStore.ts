/**
 * 章节音频 → 物理文件存储。
 *
 * 目标：「升级软件不把音频文件删了」。
 *
 * 存储位置：Capacitor `Directory.Data`
 *   · Android：/data/data/<package-id>/files/LangyueReader/audio/
 *   · iOS：App Documents/LangyueReader/audio/
 *
 * 选择 Directory.Data 而不是 ExternalStorage/Documents 的原因：
 *   1) 无任何权限要求。app 一安装就能写，100% 成功；
 *   2) 升级 / 覆盖安装时系统自动保留 files 目录下的所有文件，
 *      只有用户手动「清除数据」或「卸载」才会删除 —— 完美契合需求；
 *   3) 跨 Android 10/11/12/13/14 无 Scoped Storage 差异问题。
 *
 * 目录结构：
 *   <Data>/LangyueReader/
 *     └── audio/
 *         ├── index.json                     ← 全部音频元数据
 *         ├── 毛泽东选集_湖南农民考察报告_温润男声_20250808-081345.mp3
 *         └── ...
 *
 * 非原生环境（Web 开发预览）统一返回不可用，调用方继续走 IndexedDB 老逻辑。
 */
import { Capacitor } from '@capacitor/core'
import {
  Directory,
  Filesystem,
  Encoding,
} from '@capacitor/filesystem'
import type { AudioFileRecord } from '../types'

const AUDIO_SUB_DIR = 'LangyueReader/audio'
const INDEX_FILE = 'index.json'
/**
 * Capacitor 8 上 Directory.Data 是最稳妥的可写目录：
 *   Android: Context.getFilesDir()  /data/user/0/<pkg>/files
 *   iOS    : App 沙箱 Documents
 */
const DATA_DIR: Directory = Directory.Data

let cachedAvailable: boolean | null = null
let cachedIndex: AudioFileRecord[] | null = null
let lastError: string | null = null

/** 上一次失败的错误详情（供 UI 展示定位），原生环境下才会有值 */
export function getLastFsError(): string | null {
  return lastError
}
export function clearLastFsError() {
  lastError = null
}

export async function isAudioFsAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable
  if (!Capacitor.isNativePlatform()) {
    cachedAvailable = false
    return false
  }
  try {
    await Filesystem.mkdir({
      path: AUDIO_SUB_DIR,
      directory: DATA_DIR,
      recursive: true,
    })
    cachedAvailable = true
    lastError = null
  } catch (err) {
    cachedAvailable = false
    lastError = (err as Error)?.message ?? String(err)
  }
  return cachedAvailable
}

/** 去掉文件名中非法字符，Windows + Android + iOS 通吃 */
function safeName(s: string, max = 40): string {
  const r = String(s ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\./g, '。') // 防止误识别后缀
  return r.length > max ? r.slice(0, max) : r
}

function pad2(n: number) {
  return n.toString().padStart(2, '0')
}
function formatTs(ts: number): string {
  const d = new Date(ts)
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

/** 读 index.json，失败返回空数组 */
async function readIndex(): Promise<AudioFileRecord[]> {
  if (cachedIndex) return cachedIndex
  if (!(await isAudioFsAvailable())) return []
  try {
    const r = await Filesystem.readFile({
      path: `${AUDIO_SUB_DIR}/${INDEX_FILE}`,
      directory: DATA_DIR,
      encoding: Encoding.UTF8,
    })
    const raw = typeof r.data === 'string' ? r.data : new TextDecoder().decode(r.data as any)
    const arr = JSON.parse(raw) as AudioFileRecord[]
    cachedIndex = Array.isArray(arr) ? arr : []
  } catch (err) {
    cachedIndex = []
    lastError = (err as Error)?.message ?? String(err)
  }
  return cachedIndex!
}

/** 写 index.json（失败不抛，下次会丢失一些索引但不影响 MP3 文件本身） */
async function writeIndex(list: AudioFileRecord[]): Promise<void> {
  cachedIndex = list
  if (!(await isAudioFsAvailable())) return
  try {
    await Filesystem.writeFile({
      path: `${AUDIO_SUB_DIR}/${INDEX_FILE}`,
      directory: DATA_DIR,
      encoding: Encoding.UTF8,
      data: JSON.stringify(list, null, 2),
      recursive: true,
    })
  } catch (err) {
    lastError = (err as Error)?.message ?? String(err)
  }
}

/**
 * 把整章 MP3 二进制存到 data 目录 + 更新 index.json，返回新记录。
 */
export async function saveAudioFile(params: {
  id: string
  bookId: string
  bookTitle: string
  chapterId: string
  chapterTitle: string
  voiceKey: string
  noteVoiceKey: string
  voiceLabel: string
  textHash: string
  mp3Bytes: Uint8Array
}): Promise<AudioFileRecord> {
  const { id, bookId, bookTitle, chapterId, chapterTitle, voiceKey, noteVoiceKey, voiceLabel, textHash, mp3Bytes } = params
  if (!(await isAudioFsAvailable())) {
    const extra = lastError ? `：${lastError}` : ''
    throw new Error('文件系统存储不可用（非原生环境或权限不足）' + extra)
  }
  const list = await readIndex()
  const existing = list.find((x) => x.id === id)

  let fileName = existing?.fileName
  if (!fileName) {
    const ts = formatTs(Date.now())
    fileName = `${safeName(bookTitle)}_${safeName(chapterTitle)}_${safeName(voiceKey, 20)}_${ts}.mp3`
  }
  const relPath = `${AUDIO_SUB_DIR}/${fileName}`

  try {
    const b64 = bytesToBase64(mp3Bytes)
    await Filesystem.writeFile({
      path: relPath,
      directory: DATA_DIR,
      data: b64,
      recursive: true,
    })
  } catch (err) {
    lastError = (err as Error)?.message ?? String(err)
    throw err
  }

  const record: AudioFileRecord = {
    id,
    bookId,
    bookTitle,
    chapterId,
    chapterTitle,
    voiceKey,
    noteVoiceKey,
    voiceLabel,
    textHash,
    fileName,
    sizeBytes: mp3Bytes.byteLength,
    createdAt: existing?.createdAt ?? Date.now(),
  }
  const nextList = existing
    ? list.map((x) => (x.id === id ? record : x))
    : [...list, record]
  await writeIndex(nextList)
  return record
}

/**
 * 读一个整章 mp3 的二进制（Uint8Array）。
 * 找不到或 hash 不匹配返回 null。
 */
export async function loadAudioFile(id: string, expectedTextHash?: string): Promise<Uint8Array | null> {
  if (!(await isAudioFsAvailable())) return null
  const list = await readIndex()
  const rec = list.find((x) => x.id === id)
  if (!rec) return null
  if (expectedTextHash && rec.textHash !== expectedTextHash) return null
  try {
    const r = await Filesystem.readFile({
      path: `${AUDIO_SUB_DIR}/${rec.fileName}`,
      directory: DATA_DIR,
    })
    const b64 = typeof r.data === 'string' ? r.data : bytesToBase64(new Uint8Array(r.data as any))
    return base64ToBytes(b64)
  } catch (err) {
    lastError = (err as Error)?.message ?? String(err)
    return null
  }
}

/** 列出全部已合成音频（按时间倒序） */
export async function listAudioFiles(): Promise<AudioFileRecord[]> {
  const list = await readIndex()
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}

/** 删除一条：删文件 + 去 index */
export async function deleteAudioFile(id: string): Promise<void> {
  if (!(await isAudioFsAvailable())) return
  const list = await readIndex()
  const rec = list.find((x) => x.id === id)
  if (rec) {
    try {
      await Filesystem.deleteFile({
        path: `${AUDIO_SUB_DIR}/${rec.fileName}`,
        directory: DATA_DIR,
      })
    } catch {
      /* 忽略：文件可能已经被删了 */
    }
  }
  await writeIndex(list.filter((x) => x.id !== id))
}

/** 返回可直接喂给 new Audio(url) 播放的 URL 字符串 */
export async function getAudioPlayUrl(id: string): Promise<string | null> {
  if (!(await isAudioFsAvailable())) return null
  const list = await readIndex()
  const rec = list.find((x) => x.id === id)
  if (!rec) return null
  try {
    const uri = await Filesystem.getUri({
      path: `${AUDIO_SUB_DIR}/${rec.fileName}`,
      directory: DATA_DIR,
    })
    return Capacitor.convertFileSrc(uri.uri)
  } catch (err) {
    lastError = (err as Error)?.message ?? String(err)
    return null
  }
}

/** 返回文件绝对路径（展示给用户看） */
export async function getAudioAbsolutePath(id: string): Promise<string | null> {
  if (!(await isAudioFsAvailable())) return null
  const list = await readIndex()
  const rec = list.find((x) => x.id === id)
  if (!rec) return null
  try {
    const uri = await Filesystem.getUri({
      path: `${AUDIO_SUB_DIR}/${rec.fileName}`,
      directory: DATA_DIR,
    })
    return uri.uri
  } catch {
    return null
  }
}

/* ====== 工具：Uint8Array ↔ base64 ====== */
function bytesToBase64(bytes: Uint8Array): string {
  // 避免超过 65536 字符的 btoa 调用栈溢出：分块编码
  const CHUNK = 0x8000
  let s = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK)
    s += String.fromCharCode(...chunk)
  }
  return btoa(s)
}
function base64ToBytes(b64: string): Uint8Array {
  let s = String(b64 ?? '').trim()
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  s = s.replace(/\s+/g, '')
  const padLen = s.length % 4
  if (padLen > 0) s += '='.repeat(4 - padLen)
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
