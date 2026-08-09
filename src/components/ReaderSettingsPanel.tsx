import type { ReaderSettings } from '../types'
import { voicesForLang, VOICE_CATALOG } from '../utils/tts'

interface SettingsPanelProps {
  settings: ReaderSettings
  engineStatus: string
  onUpdateSettings: (partial: Partial<ReaderSettings>) => void
  onClose: () => void
}

export function ReaderSettingsPanel({ settings, engineStatus, onUpdateSettings, onClose }: SettingsPanelProps) {
  return (
    <div className="panel-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <span>阅读设置</span>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="setting-panel">
        <div className="row">
          <span>背景</span>
          <div className="theme-pills">
            {(
              [
                ['day', '日间'],
                ['eye', '护眼'],
                ['night', '夜间'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`${k}${settings.theme === k ? ' on' : ''}`}
                onClick={() => onUpdateSettings({ theme: k })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span>字号</span>
          <div className="stepper">
            <button type="button" onClick={() => onUpdateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })}>
              A−
            </button>
            <span>{settings.fontSize}</span>
            <button type="button" onClick={() => onUpdateSettings({ fontSize: Math.min(28, settings.fontSize + 1) })}>
              A+
            </button>
          </div>
        </div>
        <div className="row">
          <span>语速</span>
          <div className="stepper">
            <button type="button" onClick={() => onUpdateSettings({ ttsRate: Math.max(0.6, +(settings.ttsRate - 0.1).toFixed(1)) })}>
              −
            </button>
            <span>{settings.ttsRate.toFixed(1)}x</span>
            <button type="button" onClick={() => onUpdateSettings({ ttsRate: Math.min(1.8, +(settings.ttsRate + 0.1).toFixed(1)) })}>
              +
            </button>
          </div>
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <span>在线语音 · MiniMax</span>
          <div className="voice-install-box">
            <p style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.5 }}>
              在线语音合成（speech-2.8-turbo）。首次朗读每章需联网合成，之后缓存到本地，重复朗读不花钱。计费 ¥2/万字。
            </p>
            <p style={{ margin: 0, fontSize: 11, opacity: 0.75 }}>{engineStatus}</p>
          </div>
        </div>

        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <span>中文音色</span>
          <select
            className="voice-select"
            value={settings.ttsVoiceZh}
            onChange={(e) => onUpdateSettings({ ttsVoiceZh: e.target.value })}
          >
            {voicesForLang('zh').map((v) => (
              <option key={v.key} value={v.key}>
                {v.name}
              </option>
            ))}
          </select>
        </div>

        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <span>注释音色</span>
          <span style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.5 }}>
            识别*开头、[n]编号、数字编号的注释段，自动切换到此音色朗读。
          </span>
          <select
            className="voice-select"
            value={settings.ttsVoiceNote}
            onChange={(e) => onUpdateSettings({ ttsVoiceNote: e.target.value })}
          >
            {VOICE_CATALOG.map((v) => (
              <option key={`note-${v.key}`} value={v.key}>
                {v.name}
              </option>
            ))}
          </select>
        </div>

        <div className="row">
          <span>每日预算</span>
          <div className="stepper" style={{ gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              {settings.dailyBudgetYuan ? `¥${settings.dailyBudgetYuan.toFixed(2)}` : '不限制'}
            </span>
            <button type="button" onClick={() => onUpdateSettings({ dailyBudgetYuan: Math.max(0, (settings.dailyBudgetYuan || 0) - 0.5) })}>
              −
            </button>
            <button type="button" onClick={() => onUpdateSettings({ dailyBudgetYuan: Math.min(10, (settings.dailyBudgetYuan || 0) + 0.5) || 0.5 })}>
              +
            </button>
          </div>
        </div>

        <div className="row">
          <span>调试面板</span>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={!!settings.ttsDebugPanel}
              onChange={(e) => {
                onUpdateSettings({ ttsDebugPanel: e.target.checked })
              }}
            />
            展开日志（排错用，默认关）
          </label>
        </div>
      </div>
    </div>
  )
}