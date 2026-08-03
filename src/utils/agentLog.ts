/** Debug-mode logger (session 18e7c1). Mirrors to sessionStorage + console for device runs. */
const ENDPOINT = 'http://127.0.0.1:7614/ingest/ed076610-e963-431c-bb64-17c41bdead2b'
const STORAGE_KEY = 'debug-18e7c1'

export function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown> = {},
  hypothesisId?: string,
) {
  // #region agent log
  const payload = {
    sessionId: '18e7c1',
    location,
    message,
    data,
    hypothesisId,
    timestamp: Date.now(),
  }
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '18e7c1' },
    body: JSON.stringify(payload),
  }).catch(() => {})
  try {
    const line = JSON.stringify(payload)
    const prev = sessionStorage.getItem(STORAGE_KEY) || ''
    sessionStorage.setItem(STORAGE_KEY, `${line}\n${prev}`.slice(0, 12000))
    ;(window as unknown as { __TTS_DEBUG__?: unknown; __TTS_DEBUG_LAST__?: unknown }).__TTS_DEBUG__ =
      payload
    ;(window as unknown as { __TTS_DEBUG_LAST__?: unknown }).__TTS_DEBUG_LAST__ = payload
    console.info('[TTS_DEBUG]', location, message, data, hypothesisId || '')
  } catch {
    /* ignore */
  }
  // #endregion
}

/** 供界面展示最近一条调试信息 */
export function getLastDebugHint(): string {
  try {
    const last = (window as unknown as { __TTS_DEBUG_LAST__?: { message?: string; data?: Record<string, unknown> } })
      .__TTS_DEBUG_LAST__
    if (!last) return ''
    const url = typeof last.data?.url === 'string' ? last.data.url : ''
    const err = typeof last.data?.err === 'string' ? last.data.err : ''
    return [last.message, err, url].filter(Boolean).join(' | ').slice(0, 180)
  } catch {
    return ''
  }
}
