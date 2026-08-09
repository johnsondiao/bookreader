/**
 * 章节音频 → 物理文件存储。
 *
 * 目标：「升级软件不把音频文件删了」+「文件名可自恢复索引」。
 *
 * 存储位置：Capacitor `Directory.Data`
 *   · Android：/data/data/<package-id>/files/LangyueReader/audio/
 *   · iOS：App Documents/LangyueReader/audio/
 *
 * 文件名设计（结构化，可从文件名重建 index.json）：
 *   {bookTitle}~~{chapterTitle}~~{bookId}~~{chapterId}~~{voiceKey}~~{noteVoiceKey}~~{charStart}-{charEnd}~~{textHash}.mp3
 *   示例：毛泽东选集~~湖南农民考察报告~~a1b2c3~~ch-0~~minimax-warm-girl~~minimax-warm-girl~~0-5200~~abc12345.mp3
 *
 * 即使 index.json 丢失，启动时 rebuildIndexFromFiles() 会扫描目录、
 * 解析文件名重建索引，确保已合成的音频不会丢失。
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
const DATA_DIR: Directory = Directory.Data

/** 文件名各字段分隔符（safeName 不会产生 ~~） */
const SEP = '~~'

let cachedAvailable: boolean | null = null
let cachedIndex: AudioFileRecord[] | null = null
let lastError: string | null = null

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

/** 去掉文件名中非法字符（不触碰小数点，避免"毛选 2.0"变形） */
export function safeName(s: string, max = 60): string {
  const r = String(s ?? '')
    .replace(/[\\/:*?"<>|\r\n\t~]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return r.length > max ? r.slice(0, max) : r
}

/**
 * 构建结构化文件名：
 * {bookTitle}~~{chapterTitle}~~{bookId}~~{chapterId}~~{voiceKey}~~{noteVoiceKey}~~{charStart}-{charEnd}~~{textHash}.mp3
 */
function buildFileName(params: {
  bookTitle: string
  chapterTitle: string
  bookId: string
  chapterId: string
  voiceKey: string
  noteVoiceKey: string
  charStart: number
  charEnd: number
  textHash: string
}): string {
  const parts = [
    safeName(params.bookTitle, 30),
    safeName(params.chapterTitle, 30),
    params.bookId,
    params.chapterId,
    params.voiceKey,
    params.noteVoiceKey,
    `${params.charStart}-${params.charEnd}`,
    params.textHash,
  ]
  return parts.join(SEP) + '.mp3'
}

/**
 * 从文件名解析出元数据（用于 index.json 丢失时重建索引）。
 * 只解析 ~~ 分隔格式的新文件名，旧格式返回 null。
 */
function parseFileName(fileName: string): Omit<AudioFileRecord, 'sizeBytes' | 'createdAt' | 'voiceLabel'> | null {
  if (!fileName.endsWith('.mp3')) return null
  const base = fileName.slice(0, -4)
  const parts = base.split(SEP)
  if (parts.length !== 8) return null
  const [bookTitle, chapterTitle, bookId, chapterId, voiceKey, noteVoiceKey, charRange, textHash] = parts
  if (!bookId || !chapterId || !textHash) return null
  const dashIdx = charRange.indexOf('-')
  if (dashIdx < 0) return null
  const charStart = parseInt(charRange.slice(0, dashIdx), 10)
  const charEnd = parseInt(charRange.slice(dashIdx + 1), 10)
  if (isNaN(charStart) || isNaN(charEnd)) return null
  const id = `${bookId}__${chapterId}__${voiceKey}__${noteVoiceKey}`
  return {
    id,
    bookTitle,
    chapterTitle,
    bookId,
    chapterId,
    voiceKey,
    noteVoiceKey,
    textHash,
    charStart,
    charEnd,
    fileName,
  }
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
  } catch {
    cachedIndex = []
  }
  // index 为空时尝试从文件名重建
  if (cachedIndex.length === 0) {
    await rebuildIndexFromFiles()
  }
  return cachedIndex!
}

/** 写 index.json */
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
 * 扫描音频目录，从文件名重建 index.json。
 * 当 index.json 丢失或为空时自动调用，确保已合成的音频不会丢失。
 */
async function rebuildIndexFromFiles(): Promise<void> {
  if (!(await isAudioFsAvailable())) return
  try {
    const result = await Filesystem.readdir({
      path: AUDIO_SUB_DIR,
      directory: DATA_DIR,
    })
    const records: AudioFileRecord[] = []
    for (const file of result.files) {
      if (!file.name.endsWith('.mp3')) continue
      const parsed = parseFileName(file.name)
      if (!parsed) continue
      records.push({
        ...parsed,
        voiceLabel: parsed.voiceKey,
        sizeBytes: file.size ?? 0,
        createdAt: file.mtime ?? Date.now(),
      })
    }
    if (records.length > 0) {
      cachedIndex = records
      await writeIndex(records)
    }
  } catch {
    /* 目录为空或读取失败：不阻断 */
  }
}

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
  charStart: number
  charEnd: number
  mp3Bytes: Uint8Array
}): Promise<AudioFileRecord> {
  const { id, bookId, bookTitle, chapterId, chapterTitle, voiceKey, noteVoiceKey, voiceLabel, textHash, charStart, charEnd, mp3Bytes } = params
  if (!(await isAudioFsAvailable())) {
    const extra = lastError ? `：${lastError}` : ''
    throw new Error('文件系统存储不可用（非原生环境或权限不足）' + extra)
  }
  const list = await readIndex()
  const existing = list.find((x) => x.id === id)

  // 始终用结构化文件名（旧文件会被覆盖重命名）
  const fileName = buildFileName({ bookTitle, chapterTitle, bookId, chapterId, voiceKey, noteVoiceKey, charStart, charEnd, textHash })
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

  // 如果旧文件名不同，删除旧文件
  if (existing && existing.fileName !== fileName) {
    try {
      await Filesystem.deleteFile({
        path: `${AUDIO_SUB_DIR}/${existing.fileName}`,
        directory: DATA_DIR,
      })
    } catch {
      /* 旧文件可能已不存在 */
    }
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
    charStart,
    charEnd,
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

/**
 * 按 bookId + chapterId + 音色组合查找音频（不需要 index.json 也能找到）。
 */
export async function findAudioFileByMeta(
  bookId: string,
  chapterId: string,
  voiceKey: string,
  noteVoiceKey: string,
): Promise<AudioFileRecord | null> {
  const list = await readIndex()
  const id = `${bookId}__${chapterId}__${voiceKey}__${noteVoiceKey}`
  return list.find((x) => x.id === id) ?? null
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
      /* 忽略 */
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
