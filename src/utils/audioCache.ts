/**
 * 章节音频缓存（IndexedDB + 物理文件双写）。
 *
 *  1. IndexedDB（主键 key = `${bookId}__${chapterId}__${voiceCombo}`）：
 *     存分块 Blob + 字符边界，用于 App 内部段落级精准播放 + 高亮。
 *     ⚠️ 容量保护：总缓存 > MAX_BYTES(200MB) 时按 LRU 淘汰旧条目，低水位 150MB。
 *
 *  2. 物理文件 Directory.Data/LangyueReader/audio/*.mp3（仅原生环境）：
 *     把分段 chunks 按字节顺序合并成一个完整 MP3 文件。
 *     文件保存在 App 私有 files 目录下，覆盖升级时系统自动保留（只有卸载或
 *     手动清除数据才会删除）。还会写 index.json 作为索引，供「已合成音频」
 *     列表页查询/播放/删除。
 *
 *  索引 key 规则同 cacheKey：`${bookId}__${chapterId}__${voiceKey}|${noteVoiceKey}`
 *
 * IndexedDB 支持结构化克隆，可直接存 Blob 对象，无需 base64 编码。
 */
import { agentLog } from './agentLog'
import { getLastFsError, isAudioFsAvailable, saveAudioFile } from './audioFileStore'

const DB_NAME = 'langyue-reader-audio'
const STORE_NAME = 'clips'
/** IDB 缓存高水位：超过则触发 LRU 清理 */
const MAX_BYTES = 200 * 1024 * 1024 // 200MB
/** 清理目标低水位 */
const LOW_WATER_BYTES = 150 * 1024 * 1024 // 150MB
/** DB 版本：v3 新增 costTracker 的 costs store */
const DB_VERSION = 3

export interface AudioChunk {
  /** 该块在整章正文中对应的字符区间 [charStart, charEnd) */
  charStart: number
  charEnd: number
  /** mp3 Blob */
  blob: Blob
}

export interface ChapterAudio {
  /** 分块音频（按章节顺序） */
  chunks: AudioChunk[]
  /** 整章正文的哈希，用于校验缓存是否过期 */
  textHash: string
  /** 使用的音色 key（正文音色|注释音色） */
  voiceKey: string
  createdAt: number
  /** 最近一次读取/写入时间（LRU 用），v1 数据回填 createdAt */
  lastUsedAt?: number
}

/** 写外部文件时所需的额外元信息（纯 IDB 不需要这些） */
export interface ChapterFileMeta {
  bookId: string
  bookTitle: string
  chapterId: string
  chapterTitle: string
  voiceKey: string       /** 正文音色 key，对应 ttsVoices.VoiceDef.key */
  noteVoiceKey: string   /** 注释音色 key */
  voiceLabel: string     /** 展示名：温润男声 - 精英青年注释 */
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        // v1：创建 clips store
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME)
          store.createIndex('lastUsedAt', 'lastUsedAt', { unique: false })
        } else {
          const store = req.transaction!.objectStore(STORE_NAME)
          if (!store.indexNames.contains('lastUsedAt')) {
            store.createIndex('lastUsedAt', 'lastUsedAt', { unique: false })
          }
        }
        // v3：创建 costs store（供 costTracker 使用）
        if (!db.objectStoreNames.contains('costs')) {
          db.createObjectStore('costs', { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        dbPromise = null
        reject(req.error ?? new Error('音频缓存 IndexedDB 打开失败'))
      }
    })
  }
  return dbPromise
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 计算一条缓存的字节量（粗略，chunks blob.size 之和） */
function clipBytes(c: ChapterAudio): number {
  let total = 0
  const chunks = c.chunks ?? []
  for (const ch of chunks) total += ch.blob?.size ?? 0
  return total
}

/** LRU 清理：按 lastUsedAt 升序删除最久未用，直到总占用 < LOW_WATER_BYTES */
async function maybeEvict(): Promise<void> {
  try {
    const db = await openDb()
    // 1. 先全量扫一次，拿到 keys + clips（clips 可能很大，但 IDB 上限 2GB，
    //    只取元数据的话我们可 openCursor 只取 key + lastUsedAt + 预估 size？
    //    为实现简单，用 index 按 lastUsedAt 升序 openCursor，边累加边删。）
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const idx = store.indexNames.contains('lastUsedAt')
      ? store.index('lastUsedAt')
      : null
    const req: IDBRequest<IDBCursorWithValue | null> = idx
      ? idx.openCursor(null, 'next') // 升序：最老的 first
      : store.openCursor(null, 'next')

    let totalBytes = 0
    // 第一遍：遍历计算所有条目的 size 总和 + 收集条目
    const entries: { key: IDBValidKey; size: number }[] = []
    const pass1: Promise<void> = new Promise((res, rej) => {
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return res()
        const clip = cursor.value as ChapterAudio
        // v1 数据没有 lastUsedAt：用 createdAt 回填并写回
        if (!clip.lastUsedAt) {
          clip.lastUsedAt = clip.createdAt ?? Date.now()
          try { cursor.update(clip) } catch { /* ignore */ }
        }
        const size = clipBytes(clip)
        entries.push({ key: cursor.primaryKey, size })
        totalBytes += size
        cursor.continue()
      }
      req.onerror = () => rej(req.error)
    })
    await pass1
    if (totalBytes < MAX_BYTES) return // 未超限，直接返回

    // 2. 已超限 → 按 LRU 顺序删（entries 已经是升序，因为 cursor 按 lastUsedAt next）
    let deleteTarget = totalBytes - LOW_WATER_BYTES
    let deleted = 0
    for (const e of entries) {
      if (deleteTarget <= 0) break
      const tx2 = db.transaction(STORE_NAME, 'readwrite')
      try {
        await idbRequest(tx2.objectStore(STORE_NAME).delete(e.key))
        deleted += 1
        deleteTarget -= e.size
      } catch {
        // 单条删除失败跳过，避免卡死整体
      }
    }
  } catch {
    // 清理失败不影响主流程：打印即可，下一次 putClip 再尝试
  }
}

export async function getClip(key: string): Promise<ChapterAudio | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const value = (await idbRequest(store.get(key))) as ChapterAudio | undefined
    const clip = value ?? null
    if (clip) {
      const now = Date.now()
      // 命中时 touch lastUsedAt（v1 数据补 createdAt）
      if (!clip.lastUsedAt) clip.lastUsedAt = clip.createdAt ?? now
      clip.lastUsedAt = now
      await idbRequest(store.put(clip, key))
    }
    return clip
  } catch {
    return null
  }
}

export interface PutClipResult {
  /** IndexedDB 写是否成功（通常不会失败） */
  idbOk: boolean
  /** 物理文件写是否成功（纯 Web 环境 meta 缺失 → 恒为 true，视为"不需要写"） */
  fileOk: boolean
  /** 物理文件写失败时的错误原因 */
  fileError?: string
}

/**
 * 写缓存：IndexedDB 必须同步写完；外部文件则 fire-and-forget（不阻塞播放）。
 * meta 缺失时不会写外部文件（IDB 仍然写，纯 Web 环境也能正常工作）。
 * 返回 PutClipResult，调用方可以根据 fileOk 判断是否需要提示用户"音频未保存成功"。
 */
export async function putClip(
  key: string,
  clip: ChapterAudio,
  meta?: ChapterFileMeta,
): Promise<PutClipResult> {
  const now = Date.now()
  clip.lastUsedAt = now
  if (!clip.createdAt) clip.createdAt = now

  let idbOk = true
  // 1) 写 IndexedDB
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    await idbRequest(tx.objectStore(STORE_NAME).put(clip, key))
  } catch (e) {
    idbOk = false
    agentLog('audioCache:putClip', 'IndexedDB write failed', { err: e instanceof Error ? e.message : String(e), key }, 'E')
  }

  // 1.5) IDB 写完后异步尝试 LRU 清理（不阻塞播放）
  void maybeEvict()

  if (!meta) {
    // 纯 Web 环境：没有 meta，不写外部文件。这是合法场景，fileOk 视为 true
    return { idbOk, fileOk: true }
  }

  // 2) 有 meta 且 fs 可用 → 拼完整 MP3 写入外部文件
  //    await 确保文件写入完成（用户花了钱合成的音频，必须保存成功）
  let fileOk = true
  let fileError: string | undefined
  try {
    const ok = await isAudioFsAvailable()
    if (!ok) {
      // fs 不可用（非原生环境或权限不足）：不算失败，但记录下来
      const extra = getLastFsError()
      if (extra) {
        fileOk = false
        fileError = `文件系统不可用：${extra}`
        agentLog('audioCache:putClip', 'filesystem unavailable', { key, detail: extra }, 'E')
      }
    } else {
      const bytes = await concatChunkBytes(clip.chunks)
      if (bytes.length === 0) {
        fileOk = false
        fileError = '合成字节为空（可能所有段都未得到 blob）'
        agentLog('audioCache:putClip', 'concatChunkBytes empty', { key }, 'E')
      } else {
        // 从 chunks 计算字符区间
        const charStart = clip.chunks.length > 0 ? clip.chunks[0].charStart : 0
        const charEnd = clip.chunks.length > 0 ? clip.chunks[clip.chunks.length - 1].charEnd : 0
        try {
          await saveAudioFile({
            id: key,
            bookId: meta.bookId,
            bookTitle: meta.bookTitle,
            chapterId: meta.chapterId,
            chapterTitle: meta.chapterTitle,
            voiceKey: meta.voiceKey,
            noteVoiceKey: meta.noteVoiceKey,
            voiceLabel: meta.voiceLabel,
            textHash: clip.textHash,
            charStart,
            charEnd,
            mp3Bytes: bytes,
          })
        } catch (e) {
          fileOk = false
          fileError = e instanceof Error ? e.message : String(e)
          agentLog('audioCache:putClip', 'saveAudioFile failed', { key, err: fileError, size: bytes.length, charStart, charEnd }, 'E')
        }
      }
    }
  } catch (e) {
    fileOk = false
    fileError = e instanceof Error ? e.message : String(e)
    agentLog('audioCache:putClip', 'outer catch failed', { key, err: fileError }, 'E')
  }

  return { idbOk, fileOk, fileError }
}

/** 把若干 MP3 Blob 按顺序拼接成一个 Uint8Array（跳过没有 blob 的段） */
async function concatChunkBytes(chunks: { blob?: Blob }[]): Promise<Uint8Array> {
  const valid = chunks?.filter((c) => c.blob && c.blob.size > 0) ?? []
  if (valid.length === 0) return new Uint8Array(0)
  const buffers = await Promise.all(valid.map((c) => c.blob!.arrayBuffer()))
  let total = 0
  for (const b of buffers) total += b.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset)
    offset += b.byteLength
  }
  return out
}

/** 简易字符串哈希（FNV-1a 32 位），用于校验正文是否变化 */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}
