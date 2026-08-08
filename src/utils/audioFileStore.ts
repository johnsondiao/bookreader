/**
 * 章节音频 → 外部物理文件存储。
 *
 * 目标：「升级软件不把音频文件删了」。
 * 所以不用 Android app-specific 目录（卸载/升级会清空），也不用 WebView 的
 * IndexedDB/CacheStorage（未来版本迁移可能丢），而是用 Capacitor Filesystem
 * 写到公共 Documents/LangyueReader/audio/，普通文件管理器也能直接看到 mp3。
 *
 *   目录结构（以手机为例）：
 *     /sdcard/Documents/LangyueReader/
 *       ├── audio/
 *       │   ├── index.json                 ← 所有已合成音频的元数据数组
 *       │   ├── 毛泽东选集_湖南农民考察报告_minimax-news_20250808-081345.mp3
 *       │   └── ...
 *
 * Web 开发环境下没有 ExternalStorage/Documents，所以 isAvailable() 返回 false，
 * 调用方回退用 IndexedDB（audioCache.ts 老逻辑）。
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

let cachedAvailable: boolean | null = null
let cachedIndex: AudioFileRecord[] | null = null

export async function isAudioFsAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable
  // 仅原生 Android/iOS 走 Filesystem；Web 下 Directory.Documents 不支持
  if (!Capacitor.isNativePlatform()) {
    cachedAvailable = false
    return false
  }
  try {
    // 尝试创建目录；能创建就代表可用
    await Filesystem.mkdir({
      path: AUDIO_SUB_DIR,
      directory: Directory.Documents,
      recursive: true,
    })
    cachedAvailable = true
  } catch {
    cachedAvailable = false
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
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    })
    const raw = typeof r.data === 'string' ? r.data : new TextDecoder().decode(r.data as any)
    const arr = JSON.parse(raw) as AudioFileRecord[]
    cachedIndex = Array.isArray(arr) ? arr : []
  } catch {
    cachedIndex = []
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
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      data: JSON.stringify(list, null, 2),
      recursive: true,
    })
  } catch {
    /* ignore */
  }
}

/**
 * 把整章 MP3 二进制存到外部目录 + 更新 index.json，返回新记录。
 *
 * 同一 id（bookId__chapterId__voiceCombo）已存在时：
 *   - textHash 相同 → 直接返回旧记录，不重复写文件
 *   - textHash 不同 → 覆盖旧 mp3（正文更新重合成）
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
    throw new Error('文件系统存储不可用（非原生环境或权限不足）')
  }
  const list = await readIndex()
  const existing = list.find((x) => x.id === id)

  // 如果已存在且正文 hash 没变，直接复用（即使文件损坏，下面写文件也能覆盖回来）
  let fileName = existing?.fileName
  if (!fileName) {
    const ts = formatTs(Date.now())
    fileName = `${safeName(bookTitle)}_${safeName(chapterTitle)}_${safeName(voiceKey, 20)}_${ts}.mp3`
  }
  const relPath = `${AUDIO_SUB_DIR}/${fileName}`

  // 写 mp3 文件（base64 形式传进 Filesystem）
  const b64 = bytesToBase64(mp3Bytes)
  await Filesystem.writeFile({
    path: relPath,
    directory: Directory.Documents,
    data: b64,
    recursive: true,
  })

  // 更新 index
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
 * 找不到或 hash 不匹配返回 null，调用方再回退 IDB。
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
      directory: Directory.Documents,
    })
    // Capacitor readFile 在大多数平台返回 data: string (base64)
    const b64 = typeof r.data === 'string' ? r.data : bytesToBase64(new Uint8Array(r.data as any))
    return base64ToBytes(b64)
  } catch {
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
        directory: Directory.Documents,
      })
    } catch {
      /* 忽略：文件可能已经被用户手动删了 */
    }
  }
  await writeIndex(list.filter((x) => x.id !== id))
}

/**
 * 返回可直接喂给 new Audio(url) 播放的 URL 字符串。
 *   - 原生：Capacitor 把 file:///... 路径转换成 WebView 能访问的 content/https 本地 URL
 *   - Web：不支持，返回 null
 */
export async function getAudioPlayUrl(id: string): Promise<string | null> {
  if (!(await isAudioFsAvailable())) return null
  const list = await readIndex()
  const rec = list.find((x) => x.id === id)
  if (!rec) return null
  try {
    const uri = await Filesystem.getUri({
      path: `${AUDIO_SUB_DIR}/${rec.fileName}`,
      directory: Directory.Documents,
    })
    return Capacitor.convertFileSrc(uri.uri)
  } catch {
    return null
  }
}

/** 返回 Documents/LangyueReader/audio 下该文件的绝对路径（展示给用户看） */
export async function getAudioAbsolutePath(id: string): Promise<string | null> {
  if (!(await isAudioFsAvailable())) return null
  const list = await readIndex()
  const rec = list.find((x) => x.id === id)
  if (!rec) return null
  try {
    const uri = await Filesystem.getUri({
      path: `${AUDIO_SUB_DIR}/${rec.fileName}`,
      directory: Directory.Documents,
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
  // btoa: Latin-1 string → base64；上面 fromCharCode 已经按低字节压进，正确
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
