import { useEffect, useState } from 'react'
import { App as CapacitorApp, type PluginListenerHandle } from '@capacitor/app'
import { BottomNav } from './components/BottomNav'
import { CostPage } from './pages/CostPage'
import { HistoryPage } from './pages/HistoryPage'
import { MePage } from './pages/MePage'
import { ReaderPage } from './pages/ReaderPage'
import { ShelfPage } from './pages/ShelfPage'
import { useAppStore } from './store/useAppStore'
import './index.css'

function Home() {
  const tab = useAppStore((s) => s.tab)

  return (
    <div className="home">
      <div className="home-body">
        {tab === 'shelf' && <ShelfPage />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'cost' && <CostPage />}
        {tab === 'me' && <MePage />}
      </div>
      <BottomNav />
    </div>
  )
}

export default function App() {
  const screen = useAppStore((s) => s.screen)
  const [hydrated, setHydrated] = useState(() => useAppStore.persist.hasHydrated())

  useEffect(() => {
    const unsub = useAppStore.persist.onFinishHydration(() => setHydrated(true))
    if (useAppStore.persist.hasHydrated()) setHydrated(true)
    return unsub
  }, [])

  // Android 物理返回键：阅读器中返回书架，书架中退出 App
  useEffect(() => {
    let listener: PluginListenerHandle | undefined
    CapacitorApp.addListener('backButton', () => {
      const state = useAppStore.getState()
      if (state.screen === 'reader') {
        state.closeReader()
      } else {
        CapacitorApp.exitApp()
      }
    }).then((h) => { listener = h })
    return () => { listener?.remove() }
  }, [])

  if (!hydrated) {
    return (
      <div className="app-stage">
        <div className="phone-shell">
          <div className="phone-notch" />
          <div className="phone-screen">
            <div className="empty-state" style={{ paddingTop: '40%' }}>
              加载书架…
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-stage">
      <div className="phone-shell">
        <div className="phone-notch" />
        <div className="phone-screen">
          <Home />
          {screen === 'reader' && <ReaderPage />}
        </div>
        {import.meta.env.DEV && (
          <aside className="preview-hint">
            <h3>界面预览说明</h3>
            <ul>
              <li>左侧为手机框，模拟安卓界面</li>
              <li>书架三列封面，参考起点布局</li>
              <li>点封面进入阅读器</li>
              <li>点屏幕中部唤出底部菜单</li>
              <li>「听书」使用 MiniMax 在线语音合成</li>
              <li>「足迹」查看历史朗读位置</li>
            </ul>
          </aside>
        )}
      </div>
    </div>
  )
}
