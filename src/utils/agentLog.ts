/** Debug-mode logger (session 18e7c1). In-memory ring + UI subscribers for on-device visibility. */
const ENDPOINT = 'http://127.0.0.1:7614/ingest/ed076610-e963-431c-bb64-17c41bdead2b'
const STORAGE_KEY = 'debug-18e7c1'
const MAX_LINES = 40

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

export function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown> = {},
  hypothesisId?: string,
) {
  // #region agent log
  const payload: DebugPayload = {
    sessionId: '18e7c1',
    location,
    message,
    data,
    hypothesisId,
    timestamp: Date.now(),
  }
  ring.unshift(payload)
  if (ring.length > MAX_LINES) ring.length = MAX_LINES
  notify()

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '18e7c1' },
    body: JSON.stringify(payload),
  }).catch(() => {})

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
