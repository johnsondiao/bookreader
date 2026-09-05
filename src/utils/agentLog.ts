/** Debug-mode logger. In-memory ring + UI subscribers for on-device visibility. */
const ENDPOINT = import.meta.env.VITE_DEBUG_ENDPOINT || ''
const STORAGE_KEY = 'debug-18e7c1'
/** 崩溃后仍可读取的日志环（localStorage 跨进程存活；sessionStorage 崩了就没了） */
const PERSIST_KEY = 'langyue-log-ring'
const MAX_LINES = 40
const PERSIST_CAP = 60000

/** 每次启动随机生成 sessionId（不再硬编码） */
const sessionId = crypto.randomUUID()

/** 是否启用远程上报（默认关闭，避免生产环境 Network 面板红字） */
let remoteEnabled = false

/** 开启/关闭远程调试上报（仅在本地调试时按需开启） */
export function setRemoteDebugEnabled(on: boolean) {
  remoteEnabled = on
}

/** 包装 fetch 之前保留原生实现，避免调试上报被拦截/刷屏 */
export const nativeFetch: typeof fetch =
  typeof window !== 'undefined' ? window.fetch.bind(window) : fetch

export type DebugPayload = {
  sessionId: string
  location: string
  message: string
  data: Record<string, unknown>
  hypothesisId?: string
  timestamp: number
}

type Listener = (lines: DebugPayload[]) => void

const ring: DebugPayload[] = []
const listeners = new Set<Listener>()

/** 上一次会话的日志环（本次启动时从 localStorage 接过来的） */
let previousSessionRing: DebugPayload[] = []

/**
 * 启动时调用：把上次会话遗留的日志环接出来（崩溃后它还在），
 * 并清空存储开始本次会话。返回上次会话的日志供导出。
 */
export function takeOverPreviousLog(): DebugPayload[] {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    localStorage.removeItem(PERSIST_KEY)
    if (raw) previousSessionRing = JSON.parse(raw) as DebugPayload[]
  } catch {
    previousSessionRing = []
  }
  return previousSessionRing
}

export function getPreviousSessionLog(): DebugPayload[] {
  return previousSessionRing
}

let persistAt = 0
function persistRing() {
  const now = Date.now()
  if (now - persistAt < 1000) return // 节流：最多每秒写一次
  persistAt = now
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(ring).slice(0, PERSIST_CAP))
  } catch {
    /* 存储满就放弃持久化，不影响主流程 */
  }
}

function notify() {
  const snap = [...ring]
  listeners.forEach((fn) => {
    try {
      fn(snap)
    } catch {
      /* ignore */
    }
  })
}

export function subscribeDebugLog(listener: Listener): () => void {
  listeners.add(listener)
  listener([...ring])
  return () => listeners.delete(listener)
}

export function getDebugLines(): DebugPayload[] {
  return [...ring]
}

export function formatDebugLine(p: DebugPayload): string {
  const parts = [`[${p.hypothesisId || '-'}] ${p.location} · ${p.message}`]
  const d = p.data || {}
  for (const [k, v] of Object.entries(d)) {
    if (v == null || v === '') continue
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    parts.push(`${k}=${s}`)
  }
  return parts.join('\n  ')
}

export function getDebugDump(limit = 20): string {
  return ring
    .slice(0, limit)
    .map(formatDebugLine)
    .join('\n---\n')
}

/** 安装全局错误捕获：未抛异常/未处理的 rejection 也进日志环（闪退前最后线索） */
export function installGlobalErrorCapture() {
  window.addEventListener('error', (e) => {
    agentLog(
      'window.onerror',
      e.message || 'unknown error',
      { at: `${e.filename}:${e.lineno}:${e.colno}`, stack: String(e.error?.stack || '').slice(0, 600) },
      'CRASH',
    )
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    agentLog(
      'window.unhandledrejection',
      r instanceof Error ? r.message : String(r),
      { stack: String(r instanceof Error ? r.stack : '').slice(0, 600) },
      'CRASH',
    )
  })
}

export function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown> = {},
  hypothesisId?: string,
) {
  // #region agent log
  const payload: DebugPayload = {
    sessionId,
    location,
    message,
    data,
    hypothesisId,
    timestamp: Date.now(),
  }
  ring.unshift(payload)
  if (ring.length > MAX_LINES) ring.length = MAX_LINES
  notify()
  persistRing()

  if (remoteEnabled && ENDPOINT) {
    nativeFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': sessionId },
      body: JSON.stringify(payload),
    }).catch(() => {})
  }

  try {
    const line = JSON.stringify(payload)
    const prev = sessionStorage.getItem(STORAGE_KEY) || ''
    sessionStorage.setItem(STORAGE_KEY, `${line}\n${prev}`.slice(0, 20000))
    const w = window as unknown as {
      __TTS_DEBUG__?: DebugPayload
      __TTS_DEBUG_LAST__?: DebugPayload
      __TTS_DEBUG_DUMP__?: string
    }
    w.__TTS_DEBUG__ = payload
    w.__TTS_DEBUG_LAST__ = payload
    w.__TTS_DEBUG_DUMP__ = getDebugDump(15)
    console.info('[TTS_DEBUG]', location, message, data, hypothesisId || '')
  } catch {
    /* ignore */
  }
  // #endregion
}

/** 供 toast：尽量带上 modelUrl / url / key / err */
export function getLastDebugHint(): string {
  try {
    const last = (window as unknown as { __TTS_DEBUG_LAST__?: DebugPayload }).__TTS_DEBUG_LAST__
    if (!last) return ''
    const d = last.data || {}
    const bits = [
      last.message,
      typeof d.key === 'string' ? `key=${d.key}` : '',
      typeof d.engine === 'string' ? `engine=${d.engine}` : '',
      typeof d.modelUrl === 'string' ? `modelUrl=${d.modelUrl}` : '',
      typeof d.url === 'string' ? `url=${d.url}` : '',
      typeof d.from === 'string' ? `from=${d.from}` : '',
      typeof d.err === 'string' ? `err=${d.err}` : '',
      typeof d.status === 'number' ? `status=${d.status}` : '',
    ].filter(Boolean)
    return bits.join(' | ').slice(0, 500)
  } catch {
    return ''
  }
}
