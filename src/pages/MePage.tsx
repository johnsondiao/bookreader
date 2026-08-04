import { useAppStore } from '../store/useAppStore'

export function MePage() {
  const books = useAppStore((s) => s.books)
  const snapshots = useAppStore((s) => s.snapshots)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const removeBook = useAppStore((s) => s.removeBook)

  const reading = books.filter((b) => b.progressPercent > 0).length
  const ttsCount = snapshots.filter((s) => s.source === 'tts').length

  return (
    <div>
      <header className="page-header">
        <h1>我的</h1>
        <p className="sub">朗阅 · 本地电子书朗读</p>
      </header>

      <div className="me-card">
        <div className="name">本地读者</div>
        <div className="me-stats">
          <div>
            <div className="n">{books.length}</div>
            <div className="l">藏书</div>
          </div>
          <div>
            <div className="n">{reading}</div>
            <div className="l">在读</div>
          </div>
          <div>
            <div className="n">{ttsCount}</div>
            <div className="l">朗读记录</div>
          </div>
        </div>
      </div>

      <div className="setting-list">
        <div className="setting-row">
          <span>朗读语速</span>
          <div className="stepper">
            <button type="button" onClick={() => updateSettings({ ttsRate: Math.max(0.6, +(settings.ttsRate - 0.1).toFixed(1)) })}>
              −
            </button>
            <span className="val">{settings.ttsRate.toFixed(1)}x</span>
            <button type="button" onClick={() => updateSettings({ ttsRate: Math.min(1.8, +(settings.ttsRate + 0.1).toFixed(1)) })}>
              +
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span>默认字体</span>
          <div className="stepper">
            <button type="button" onClick={() => updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })}>
              A−
            </button>
            <span className="val">{settings.fontSize}</span>
            <button type="button" onClick={() => updateSettings({ fontSize: Math.min(28, settings.fontSize + 1) })}>
              A+
            </button>
          </div>
        </div>
        <button
          type="button"
          className="setting-row"
          onClick={() => {
            const themes = ['day', 'eye', 'night'] as const
            const i = themes.indexOf(settings.theme)
            updateSettings({ theme: themes[(i + 1) % themes.length] })
          }}
        >
          <span>阅读主题</span>
          <span className="val">{settings.theme === 'day' ? '日间' : settings.theme === 'eye' ? '护眼' : '夜间'}</span>
        </button>
      </div>

      {books.length > 0 && (
        <div className="setting-list">
          <div className="setting-row" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            书籍管理 · 仅从书架移除，不会删除原文件
          </div>
          {books.map((b) => (
            <button key={b.id} type="button" className="setting-row" onClick={() => removeBook(b.id)}>
              <span>移除「{b.title}」</span>
              <span className="val" style={{ color: 'var(--accent)' }}>
                移除
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
