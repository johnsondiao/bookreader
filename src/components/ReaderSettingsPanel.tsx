import { READER_THEMES, type ReaderSettings } from '../types'
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
            {READER_THEMES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`${key}${settings.theme === key ? ' on' : ''}`}
                onClick={() => onUpdateSettings({ theme: key })}
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
          <span>行距</span>
          <div className="stepper">
            <button type="button" onClick={() => onUpdateSettings({ lineHeight: Math.max(1.4, +(settings.lineHeight - 0.1).toFixed(1)) })}>
              −
            </button>
            <span>{settings.lineHeight.toFixed(1)}</span>
            <button type="button" onClick={() => onUpdateSettings({ lineHeight: Math.min(2.6, +(settings.lineHeight + 0.1).toFixed(1)) })}>
              +
            </button>
          </div>
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <span>翻页方式</span>
          <div className="theme-pills" style={{ justifyContent: 'flex-start' }}>
            {(
              [
                ['scroll', '上下滚动'],
                ['flip', '左右翻页'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`day${(settings.pagingMode ?? 'scroll') === k ? ' on' : ''}`}
                style={{ width: 'auto', minWidth: 72, padding: '0 10px', height: 34 }}
                onClick={() => onUpdateSettings({ pagingMode: k })}
              >
                {label}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.5 }}>
            上下滚动：横滑切换章节，点按上/下方跳句。左右翻页：横滑或点按左/右侧像翻书一样整屏翻页，翻到本章末尾继续翻自动切章。
            两种模式都可点屏幕中间或顶部标题栏收起/展开菜单。
          </span>
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