import { formatDebugLine, type DebugPayload } from '../utils/agentLog'

interface DebugPanelProps {
  debugOpen: boolean
  debugLines: DebugPayload[]
  onToggle: () => void
}

export function DebugPanel({ debugOpen, debugLines, onToggle }: DebugPanelProps) {
  return (
    <div className={`tts-debug-panel${debugOpen ? ' open' : ''}`}>
      <button type="button" className="tts-debug-toggle" onClick={onToggle}>
        {debugOpen ? '收起调试' : '展开调试'} ({debugLines.length})
      </button>
      {debugOpen && (
        <pre className="tts-debug-body">
          {debugLines.length === 0
            ? '暂无日志。点听书后这里会显示每一步（下载 URL / 错误 / 音量）。'
            : debugLines.slice(0, 25).map(formatDebugLine).join('\n---\n')}
        </pre>
      )}
    </div>
  )
}