/** Debug-mode NDJSON logger (session 18e7c1). Safe no-op if ingest unreachable (e.g. phone). */
export function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown> = {},
  hypothesisId?: string,
) {
  // #region agent log
  fetch('http://127.0.0.1:7614/ingest/ed076610-e963-431c-bb64-17c41bdead2b', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '18e7c1' },
    body: JSON.stringify({
      sessionId: '18e7c1',
      location,
      message,
      data,
      hypothesisId,
      timestamp: Date.now(),
    }),
  }).catch(() => {})
  try {
    const line = `[${hypothesisId || '-'}] ${message} ${JSON.stringify(data)}`
    const prev = sessionStorage.getItem('langyue-debug-events') || ''
    sessionStorage.setItem('langyue-debug-events', `${line}\n${prev}`.slice(0, 4000))
  } catch {
    /* ignore */
  }
  // #endregion
}

export function readAgentEvents(): string {
  try {
    return sessionStorage.getItem('langyue-debug-events') || ''
  } catch {
    return ''
  }
}
