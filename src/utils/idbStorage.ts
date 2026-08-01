import type { PersistStorage, StorageValue } from 'zustand/middleware'

const DB_NAME = 'langyue-reader'
const STORE_NAME = 'kv'
const LEGACY_LS_KEY = 'langyue-reader-v1'

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
        reject(req.error ?? new Error('IndexedDB 打开失败'))
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

/** 直接存对象，避免大书 JSON.stringify 卡死主线程 */
export function createIdbStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => {
      try {
        const db = await openDb()
        const tx = db.transaction(STORE_NAME, 'readonly')
        const value = await idbRequest(tx.objectStore(STORE_NAME).get(name))
        if (value != null) return value as StorageValue<S>

        // 迁移旧 localStorage 数据（并去掉双份 content，减小体积）
        const legacy = localStorage.getItem(LEGACY_LS_KEY)
        if (!legacy) return null
        try {
          const parsed = JSON.parse(legacy) as StorageValue<S>
          const state = parsed?.state as { books?: Array<{ content?: string }> } | undefined
          if (state?.books) {
            state.books = state.books.map((b) => ({ ...b, content: '' }))
          }
          const wtx = db.transaction(STORE_NAME, 'readwrite')
          await idbRequest(wtx.objectStore(STORE_NAME).put(parsed, name))
          localStorage.removeItem(LEGACY_LS_KEY)
          return parsed
        } catch {
          return null
        }
      } catch {
        return null
      }
    },
    setItem: async (name, value) => {
      const db = await openDb()
      const tx = db.transaction(STORE_NAME, 'readwrite')
      await idbRequest(tx.objectStore(STORE_NAME).put(value, name))
    },
    removeItem: async (name) => {
      const db = await openDb()
      const tx = db.transaction(STORE_NAME, 'readwrite')
      await idbRequest(tx.objectStore(STORE_NAME).delete(name))
    },
  }
}
