import { READER_THEMES, type ReaderSettings } from '../types'

interface SettingsPanelProps {
  settings: ReaderSettings
  onUpdateSettings: (partial: Partial<ReaderSettings>) => void
  onClose: () => void
}

export function ReaderSettingsPanel({ settings, onUpdateSettings, onClose }: SettingsPanelProps) {
  return (
    <div className="panel-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <span>阅读设置</span>
        <button type="button" onClick={onClose}>关闭</button>
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
            <button type="button" onClick={() => onUpdateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })}>A−</button>
            <span>{settings.fontSize}</span>
            <button type="button" onClick={() => onUpdateSettings({ fontSize: Math.min(28, settings.fontSize + 1) })}>A+</button>
          </div>
        </div>
        <div className="row">
          <span>行距</span>
          <div className="stepper">
            <button type="button" onClick={() => onUpdateSettings({ lineHeight: Math.max(1.4, +(settings.lineHeight - 0.1).toFixed(1)) })}>−</button>
            <span>{settings.lineHeight.toFixed(1)}</span>
            <button type="button" onClick={() => onUpdateSettings({ lineHeight: Math.min(2.6, +(settings.lineHeight + 0.1).toFixed(1)) })}>+</button>
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
            上下滚动：横滑切换章节，点按上/下方跳句。左右翻页：横滑或点按左/右侧像翻书一样整屏翻页。
          </span>
        </div>
        <div className="row">
          <span>播放语速</span>
          <div className="stepper">
            <button type="button" onClick={() => onUpdateSettings({ playbackRate: Math.max(0.6, +(settings.playbackRate - 0.1).toFixed(1)) })}>−</button>
            <span>{settings.playbackRate.toFixed(1)}x</span>
            <button type="button" onClick={() => onUpdateSettings({ playbackRate: Math.min(1.8, +(settings.playbackRate + 0.1).toFixed(1)) })}>+</button>
          </div>
        </div>
      </div>
    </div>
  )
}
