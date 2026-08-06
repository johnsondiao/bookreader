/**
 * MiniMax TTS key 解锁与持久化。
 *
 * 密文硬编码在 ttsKeyCipher.ts（构建期用密码 12345 + PBKDF2+AES-GCM 加密）。
 * 用户首次运行 App 时输入密码 → 解密 → 明文 key 存 IndexedDB。
 * 之后每次启动直接从 IndexedDB 读明文 key，不再要求输入密码。
 *
 * 安全权衡：
 *   - bundle 反编译拿不到明文 key（只有密文 + iv + salt）
 *   - 设备 IndexedDB 里有明文 key，但只有用户自己输对了密码才会写入
 *   - 别人拿到你的 APK 装机，没密码也用不了；拿到你已解锁的设备另说
 *
 * 想完全无明文 key 落地，可改成「密码只存内存，App 重启必须重输」——
 * 把 setTtsKey 的 IndexedDB 写入去掉即可，但每次启动都要输密码，体验差。
 */
import { TTS_KEY_CIPHER, TTS_KEY_IV, TTS_KEY_SALT } from './ttsKeyCipher'

const PBKDF2_ITER = 100_000
const IDB_NAME = 'langyue-reader-secure'
const IDB_STORE = 'keys'
const IDB_KEY = 'minimax-key'

/** 解密失败 / 缺失 key 时抛出，上层据此弹密码框 */
export class TtsKeyLockedError extends Error {
  constructor() {
    super('语音功能需要解锁（输入密码）')
    this.name = 'TtsKeyLockedError'
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        dbPromise = null
        reject(req.error ?? new Error('安全存储打开失败'))
      }
    })
  }
  return dbPromise
}

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then((db) => {
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const r = tx.objectStore(IDB_STORE).get(key)
      r.onsuccess = () => resolve(r.result as T | undefined)
      r.onerror = () => reject(r.error)
    })
  })
}

function idbPut(key: string, value: string): Promise<void> {
  return openDb().then((db) => {
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })
}

function idbDelete(key: string): Promise<void> {
  return openDb().then((db) => {
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })
}

/** base64 → ArrayBuffer（TS 5.7+ 要求 BufferSource 底层为 ArrayBuffer 而非 ArrayBufferLike） */
function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return buf
}

/** 用密码 + salt/iv 解密硬编码的密文，返回明文 key；密码错或密文坏返回 null */
export async function decryptTtsKey(password: string): Promise<string | null> {
  if (!TTS_KEY_CIPHER || !TTS_KEY_IV || !TTS_KEY_SALT) return null
  try {
    const subtle = crypto.subtle
    const salt = b64ToBuf(TTS_KEY_SALT)
    const iv = b64ToBuf(TTS_KEY_IV)
    const cipher = b64ToBuf(TTS_KEY_CIPHER)

    const baseKey = await subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    )
    const aesKey = await subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    )
    const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher)
    return new TextDecoder().decode(plainBuf)
  } catch {
    return null
  }
}

/** 是否已经在 IndexedDB 中有明文 key（用于决定是否要弹密码框） */
export async function hasTtsKey(): Promise<boolean> {
  try {
    const v = await idbGet<string>(IDB_KEY)
    return !!v
  } catch {
    return false
  }
}

/** 取明文 key；没有则抛 TtsKeyLockedError，调用方据此弹密码框 */
export async function getTtsKey(): Promise<string> {
  try {
    const v = await idbGet<string>(IDB_KEY)
    if (v) return v
  } catch {
    /* fallthrough */
  }
  throw new TtsKeyLockedError()
}

/**
 * 用密码尝试解锁：解密成功 → 存 IndexedDB → 返回 true；
 * 密码错 / 密文损坏 → 返回 false（不抛错，便于 UI 直接提示「密码错误」）
 */
export async function unlockTtsKey(password: string): Promise<boolean> {
  const plain = await decryptTtsKey(password)
  if (!plain) return false
  try {
    await idbPut(IDB_KEY, plain)
  } catch {
    /* 即使写不进 IDB，内存里也已经能用，但下次启动还要再输。
       这里不缓存内存，因为 getTtsKey 走 IDB；写失败就当解锁失败。 */
    return false
  }
  return true
}

/** 清除已解锁的 key（重新要求输密码）。用于「重置语音解锁」按钮。 */
export async function lockTtsKey(): Promise<void> {
  try {
    await idbDelete(IDB_KEY)
  } catch {
    /* ignore */
  }
}
