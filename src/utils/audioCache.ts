/**
 * 章节音频缓存（IndexedDB）。
 *
 * 已合成的整章音频按「书 id + 章 id + 音色 key」缓存，避免重复调用 MiniMax 合成花钱。
 * 存的是分块 Blob（长章节按段落边界切成多块，每块一次异步 T2A），用 textHash 校验：
 * 若章节正文变化（如重新导入），textHash 不匹配则重新合成并覆盖。
 *
 * IndexedDB 支持结构化克隆，可直接存 Blob 对象，无需 base64 编码。
 */

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
  /** 使用的音色 key */
  voiceKey: string
  createdAt: number
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

export async function putClip(key: string, clip: ChapterAudio): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    await idbRequest(tx.objectStore(STORE_NAME).put(clip, key))
  } catch {
    /* 缓存写入失败不阻断播放 */
  }
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
