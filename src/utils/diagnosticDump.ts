/**
 * 崩溃诊断导出。
 *
 * 闪退（尤其是原生层 OOM/abort）不会留下 JS 异常栈，唯一线索是：
 *   - 朗读心跳哨兵（每 8 句写一次，含 JS 堆用量）
 *   - JS 日志环：本次会话 + 上次会话（localStorage 跨进程存活）
 *   - 原生层日志 localtts.log（init/synth 起止 + Java 堆 free/max）
 *   - 设备/UA/堆信息
 * 拼成一段文本供用户复制发给开发者。
 */
import {
  formatDebugLine,
  getDebugLines,
  getPreviousSessionLog,
  installGlobalErrorCapture,
  takeOverPreviousLog,
} from './agentLog'
import { getNativeLog } from './localTts'

/** 启动时调用一次：接管上次会话日志 + 安装全局错误捕获 */
export function initDiagnosticCapture() {
  takeOverPreviousLog()
  installGlobalErrorCapture()
}

export async function buildDiagnosticDump(sentinel: string | null): Promise<string> {
  const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number }
  const mem = (
    performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }
  ).memory
  const lines: string[] = []
  lines.push(`== 朗阅诊断 v${__APP_VERSION__} build ${__APP_BUILD__} ==`)
  lines.push(`time=${new Date().toISOString()}`)
  lines.push(`ua=${nav.userAgent}`)
  lines.push(`deviceMemory=${nav.deviceMemory ?? '?'} cores=${nav.hardwareConcurrency ?? '?'}`)
  if (mem) {
    lines.push(
      `jsHeap=${((mem.usedJSHeapSize ?? 0) / 1048576).toFixed(1)}MB / limit ${((mem.jsHeapSizeLimit ?? 0) / 1048576).toFixed(0)}MB`,
    )
  }
  lines.push(`crashSentinel=${sentinel ?? '(无)'}`)

  const prev = getPreviousSessionLog()
  lines.push('')
  lines.push('== 上次会话日志（崩溃前最后记录，按时间正序） ==')
  lines.push(prev.length ? [...prev].reverse().map(formatDebugLine).join('\n---\n') : '(空)')

  const cur = getDebugLines()
  lines.push('')
  lines.push('== 本次会话日志（按时间正序） ==')
  lines.push(cur.length ? [...cur].reverse().map(formatDebugLine).join('\n---\n') : '(空)')

  lines.push('')
  lines.push('== 原生层日志 localtts.log ==')
  try {
    lines.push((await getNativeLog()) || '(空)')
  } catch {
    lines.push('(读取失败)')
  }
  return lines.join('\n')
}

/** 复制到剪贴板（WebView 里 navigator.clipboard 常不可用，走 execCommand 兜底） */
export async function copyDiagnostic(sentinel: string | null): Promise<boolean> {
  const text = await buildDiagnosticDump(sentinel)
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
