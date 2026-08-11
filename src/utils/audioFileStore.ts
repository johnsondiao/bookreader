/**
 * 章节音频 → 物理文件存储。
 *
 * 目标：「升级软件不把音频文件删了」+「卸载重装不丢」+「文件名可自恢复索引」。
 *
 * 存储位置：Capacitor `Directory.Documents`（共享存储，独立于应用私有目录）
 *   · Android 11+：MediaStore 共享 Documents 目录
 *     /storage/emulated/0/Documents/LangyueReader/audio/
 *     —— 系统卸载时**不会删除**；同包名同签名重装后仍可继续读写自己创建的文件
 *   · Android 10 及以下：外部存储 Documents（需 READ/WRITE_EXTERNAL_STORAGE，
 *     manifest 已限 maxSdkVersion=29，首次失败时自动申请权限）
 *   · iOS：App Documents/LangyueReader/audio/
 *
 * 历史兼容：旧版本写在 Directory.Data（/data/data/<pkg>/files/，卸载即被系统清空），
 * 覆盖升级场景下 initAudioStore() 会把旧目录残留的 .mp3 自动迁移到新位置。
 *
 * 文件名设计（结构化，可从文件名重建 index.json）：
 *   {bookTitle}~~{chapterTitle}~~{bookId}~~{chapterId}~~{voiceKey}~~{noteVoiceKey}~~{charStart}-{charEnd}~~{textHash}.mp3
 *   示例：毛泽东选集~~湖南农民考察报告~~a1b2c3~~ch-0~~minimax-warm-girl~~minimax-warm-girl~~0-5200~~abc12345.mp3
 *
 * 即使 index.json 丢失，rebuildIndexFromFiles() 会扫描目录、
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
/** 新存储位置：共享 Documents 目录（卸载重装不丢，PRD §5.3） */
const STORAGE_DIR: Directory = Directory.Documents
/** 旧版本存储位置：应用私有目录（卸载即被系统清空，仅覆盖升级时可迁移） */
const LEGACY_DIR: Directory = Directory.Data

/** 文件名各字段分隔符（safeName 不会产生 ~~） */
const SEP = '~~'

let cachedAvailable: boolean | null = null
let cachedIndex: AudioFileRecord[] | null = null
let lastError: string | null = null
let initPromise: Promise<AudioStoreInit> | null = null

export interface AudioStoreInit {
  /** 音频目录是否可用 */
  ok: boolean
  /** 从旧版本私有目录迁移过来的文件数 */
  migrated: number
  /** index.json 缺失时通过文件名自恢复出的历史音频条数 */
  recovered: number
}

export function getLastFsError(): string | null {
  return lastError
}
export function clearLastFsError() {
  lastError = null
}

/**
 * 音频库初始化（幂等，一个会话只跑一次）：
 *  1. 在 Documents 下建音频目录（Android 10 及以下失败时自动申请权限重试）
 *  2. 迁移旧版本 Directory.Data 里的残留文件（仅覆盖升级场景；卸载后该目录已被清空）
 *  3. index.json 缺失/为空时扫描文件名自恢复索引（重装恢复流程，PRD §5.3）
 */
export function initAudioStore(): Promise<AudioStoreInit> {
  if (!initPromise) initPromise = doInitAudioStore()
  return initPromise
}

async function doInitAudioStore(): Promise<AudioStoreInit> {
  const ok = await ensureAvailable()
  if (!ok) return { ok: false, migrated: 0, recovered: 0 }
  const migrated = await migrateLegacyFiles()
  let recovered = 0
  const hasIndex = await tryLoadIndex()
  if (!hasIndex) recovered = await rebuildIndexFromFiles()
  return { ok: true, migrated, recovered }
}

/**
 * 创建音频目录。
 * 注意：@capacitor/filesystem v8（IONFILE 实现）的 mkdir 即使传 recursive:true，
 * 目录已存在时也会报 "already exists, cannot be overwritten"，必须容错处理，
 * 否则听书写入音频后再进音频列表页就会初始化失败。
 * 返回：'ok'（含已存在）/ 'fail'（附 lastError）
 */
async function tryMkdir(): Promise<'ok' | 'fail'> {
  try {
    await Filesystem.mkdir({ path: AUDIO_SUB_DIR, directory: STORAGE_DIR, recursive: true })
    return 'ok'
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    // 目录已存在：等价于创建成功
    if (/already exists/i.test(msg)) return 'ok'
    lastError = msg
    return 'fail'
  }
}

/** 创建音频目录；失败（Android 10 及以下常见为权限问题）时申请权限后重试一次 */
async function ensureAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable
  if (!Capacitor.isNativePlatform()) {
    cachedAvailable = false
    return false
  }
  if ((await tryMkdir()) === 'ok') {
    cachedAvailable = true
    lastError = null
    return true
  }
  try {
    const st = await Filesystem.requestPermissions()
    if (st.publicStorage === 'granted' && (await tryMkdir()) === 'ok') {
      cachedAvailable = true
      lastError = null
      return true
    }
  } catch {
    /* 权限申请失败：按原错误处理 */
  }
  cachedAvailable = false
  return false
}

/** 兼容旧接口：等价于 initAudioStore() 的 ok 字段 */
export async function isAudioFsAvailable(): Promise<boolean> {
  return (await initAudioStore()).ok
}

/**
 * 把旧版本残留在 Directory.Data 的音频文件迁移到新的 Documents 位置：
 * 复制 → 校验 → 删旧文件。仅覆盖升级时有东西可迁；卸载重装后旧目录已被系统清空。
 */
async function migrateLegacyFiles(): Promise<number> {
  let moved = 0
  try {
    const legacy = await Filesystem.readdir({ path: AUDIO_SUB_DIR, directory: LEGACY_DIR })
    for (const f of legacy.files) {
      if (!f.name.endsWith('.mp3')) continue
      const rel = `${AUDIO_SUB_DIR}/${f.name}`
      // 新位置已有同名文件 → 跳过
      try {
        await Filesystem.stat({ path: rel, directory: STORAGE_DIR })
        continue
      } catch {
        /* 不存在，需要迁移 */
      }
      try {
        const r = await Filesystem.readFile({ path: rel, directory: LEGACY_DIR })
        await Filesystem.writeFile({ path: rel, directory: STORAGE_DIR, data: r.data as string, recursive: true })
        // 校验写入成功后才删旧文件（迁移完成，避免两处重复计入索引）
        await Filesystem.stat({ path: rel, directory: STORAGE_DIR })
        try {
          await Filesystem.deleteFile({ path: rel, directory: LEGACY_DIR })
        } catch {
          /* 旧文件删除失败不影响：新位置已安全保存 */
        }
        moved++
      } catch (e) {
        lastError = (e as Error)?.message ?? String(e)
      }
    }
  } catch {
    /* 旧目录不存在：没有可迁移的内容 */
  }
  return moved
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

/** 把 index.json 载入缓存，返回是否有效且非空（不触发 init，供初始化流程内部使用） */
async function tryLoadIndex(): Promise<boolean> {
  if (cachedIndex && cachedIndex.length > 0) return true
  try {
    const r = await Filesystem.readFile({
      path: `${AUDIO_SUB_DIR}/${INDEX_FILE}`,
      directory: STORAGE_DIR,
      encoding: Encoding.UTF8,
    })
    const raw = typeof r.data === 'string' ? r.data : new TextDecoder().decode(r.data as any)
    const arr = JSON.parse(raw) as AudioFileRecord[]
    cachedIndex = Array.isArray(arr) ? arr : []
  } catch {
    cachedIndex = []
  }
  return cachedIndex.length > 0
}

/** 读 index.json，失败返回空数组 */
async function readIndex(): Promise<AudioFileRecord[]> {
  if (cachedIndex && cachedIndex.length > 0) return cachedIndex
  if (!(await isAudioFsAvailable())) return []
  await tryLoadIndex()
  // index 为空时尝试从文件名重建（重装恢复场景）
  if (!cachedIndex || cachedIndex.length === 0) {
    await rebuildIndexFromFiles()
  }
  return cachedIndex ?? []
}

/** 写 index.json */
async function writeIndex(list: AudioFileRecord[]): Promise<void> {
  cachedIndex = list
  if (!(await ensureAvailable())) return
  try {
    await Filesystem.writeFile({
      path: `${AUDIO_SUB_DIR}/${INDEX_FILE}`,
      directory: STORAGE_DIR,
      encoding: Encoding.UTF8,
      data: JSON.stringify(list, null, 2),
      recursive: true,
    })
  } catch (err) {
    lastError = (err as Error)?.message ?? String(err)
  }
}

/**
 * 扫描音频目录，从文件名重建 index.json，返回恢复出的条数。
 * 当 index.json 丢失或为空时自动调用（卸载重装后索引随之丢失，靠文件名自恢复）。
 */
async function rebuildIndexFromFiles(): Promise<number> {
  if (!(await ensureAvailable())) return 0
  try {
    const result = await Filesystem.readdir({
      path: AUDIO_SUB_DIR,
      directory: STORAGE_DIR,
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
    return records.length
  } catch {
    /* 目录为空或读取失败：不阻断 */
    return 0
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
      directory: STORAGE_DIR,
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
        directory: STORAGE_DIR,
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
      directory: STORAGE_DIR,
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
        directory: STORAGE_DIR,
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
      directory: STORAGE_DIR,
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
      directory: STORAGE_DIR,
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
