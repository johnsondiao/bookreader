/** Debug-mode logger (session 18e7c1). Also mirrors to sessionStorage for device runs. */
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
  fetch('http://127.0.0.1:7614/ingest/ed076610-e963-431c-bb64-17c41bdead2b', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '18e7c1' },
    body: JSON.stringify(payload),
  }).catch(() => {})
  try {
    const line = JSON.stringify(payload)
    const prev = sessionStorage.getItem('debug-18e7c1') || ''
    sessionStorage.setItem('debug-18e7c1', `${line}\n${prev}`.slice(0, 8000))
    ;(window as unknown as { __TTS_DEBUG__?: unknown }).__TTS_DEBUG__ = payload
  } catch {
    /* ignore */
  }
  // #endregion
}
