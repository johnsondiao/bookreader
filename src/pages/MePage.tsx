import { useAppStore } from '../store/useAppStore'
import { READER_THEMES } from '../types'

export function MePage() {
  const books = useAppStore((s) => s.books)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const removeBook = useAppStore((s) => s.removeBook)

  const reading = books.filter((b) => b.progressPercent > 0).length
  const audiobooks = books.filter((b) => (b.audioChapterCount ?? 0) > 0).length

  return (
    <div>
      <header className="page-header">
        <h1>我的</h1>
        <p className="sub">朗阅 · 本地电子书朗读 · v{__APP_VERSION__} (build {__APP_BUILD__})</p>
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
            <div className="n">{audiobooks}</div>
            <div className="l">有声书</div>
          </div>
        </div>
      </div>

      <div className="setting-list">
        <div className="setting-row">
          <span>播放语速</span>
          <div className="stepper">
            <button type="button" onClick={() => updateSettings({ playbackRate: Math.max(0.6, +(settings.playbackRate - 0.1).toFixed(1)) })}>−</button>
            <span className="val">{settings.playbackRate.toFixed(1)}x</span>
            <button type="button" onClick={() => updateSettings({ playbackRate: Math.min(1.8, +(settings.playbackRate + 0.1).toFixed(1)) })}>+</button>
          </div>
        </div>
        <div className="setting-row">
          <span>默认字体</span>
          <div className="stepper">
            <button type="button" onClick={() => updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })}>A−</button>
            <span className="val">{settings.fontSize}</span>
            <button type="button" onClick={() => updateSettings({ fontSize: Math.min(28, settings.fontSize + 1) })}>A+</button>
          </div>
        </div>
        <button
          type="button"
          className="setting-row"
          onClick={() => {
            const i = READER_THEMES.findIndex((t) => t.key === settings.theme)
            updateSettings({ theme: READER_THEMES[(i + 1) % READER_THEMES.length].key })
          }}
        >
          <span>阅读主题</span>
          <span className="val">{READER_THEMES.find((t) => t.key === settings.theme)?.label ?? '日间'}</span>
        </button>
      </div>

      {books.length > 0 && (
        <div className="setting-list" style={{ marginTop: 16 }}>
          <div className="setting-row" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            书籍管理 · 移除会同时删除其音频文件
          </div>
          {books.map((b) => {
            const audio = b.audioChapterCount ?? 0
            return (
              <button
                key={b.id}
                type="button"
                className="setting-row"
                onClick={() => {
                  const tip = audio > 0 ? `\n\n（同时删除 ${audio} 章音频文件）` : ''
                  if (confirm(`移除「${b.title}」？${tip}`)) removeBook(b.id)
                }}
              >
                <span>移除「{b.title}」</span>
                <span className="val" style={{ color: 'var(--accent)' }}>
                  {audio > 0 ? `有声 ${audio} 章` : '移除'}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
