/**
 * 章节音频缓存（IndexedDB + 物理文件双写）。
 *
 *  1. IndexedDB（主键 key = `${bookId}__${chapterId}__${voiceCombo}`）：
 *     存分块 Blob + 字符边界，用于 App 内部段落级精准播放 + 高亮。
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
import { isAudioFsAvailable, saveAudioFile } from './audioFileStore'

const DB_NAME = 'langyue-reader-audio'
const STORE_NAME = 'clips'

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

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
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

export async function getClip(key: string): Promise<ChapterAudio | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const value = await idbRequest(tx.objectStore(STORE_NAME).get(key))
    return (value as ChapterAudio | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * 写缓存：IndexedDB 必须同步写完；外部文件则 fire-and-forget（不阻塞播放）。
 * meta 缺失时不会写外部文件（IDB 仍然写，纯 Web 环境也能正常工作）。
 */
export async function putClip(
  key: string,
  clip: ChapterAudio,
  meta?: ChapterFileMeta,
): Promise<void> {
  // 1) 写 IndexedDB
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    await idbRequest(tx.objectStore(STORE_NAME).put(clip, key))
  } catch {
    /* 缓存写入失败不阻断播放 */
  }

  // 2) 有 meta 且 fs 可用 → 异步拼完整 MP3 写入 Documents
  //    不 await：避免合成后多等 IO；即使失败也不影响 IDB 缓存命中
  if (meta) {
    void (async () => {
      try {
        const ok = await isAudioFsAvailable()
        if (!ok) return
        const bytes = await concatChunkBytes(clip.chunks)
        if (bytes.length === 0) return
        await saveAudioFile({
          id: key, // cacheKey 直接作为索引 id，方便读回时 match
          bookId: meta.bookId,
          bookTitle: meta.bookTitle,
          chapterId: meta.chapterId,
          chapterTitle: meta.chapterTitle,
          voiceKey: meta.voiceKey,
          noteVoiceKey: meta.noteVoiceKey,
          voiceLabel: meta.voiceLabel,
          textHash: clip.textHash,
          mp3Bytes: bytes,
        })
      } catch {
        /* ignore：外部存储是锦上添花，不应该让用户感知到写失败 */
      }
    })()
  }
}

/** 把若干 MP3 Blob 按顺序拼接成一个 Uint8Array */
async function concatChunkBytes(chunks: { blob: Blob }[]): Promise<Uint8Array> {
  if (!chunks || chunks.length === 0) return new Uint8Array(0)
  const buffers = await Promise.all(chunks.map((c) => c.blob.arrayBuffer()))
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
