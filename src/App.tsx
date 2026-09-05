import { useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { BottomNav } from './components/BottomNav'
import { ImportStatsModal } from './components/ImportStatsModal'
import { CostPage } from './pages/CostPage'
import { HistoryPage } from './pages/HistoryPage'
import { MePage } from './pages/MePage'
import { ReaderPage } from './pages/ReaderPage'
import { ShelfPage } from './pages/ShelfPage'
import { useAppStore } from './store/useAppStore'
import { consumeCrashReport, installCleanExitMarker } from './utils/tts'
import './index.css'

function Home() {
  const tab = useAppStore((s) => s.tab)
  const openBook = useAppStore((s) => s.openBook)
  const setImportStatsBook = useAppStore((s) => s.setImportStatsBook)
  // 只在有值时取出对应书对象（引用稳定），避免阅读进度写入时整个 Home 跟着重渲染
  const statsBook = useAppStore((s) =>
    s.importStatsBookId ? (s.books.find((b) => b.id === s.importStatsBookId) ?? null) : null,
  )

  return (
    <div className="home">
      <div className="home-body">
        {tab === 'shelf' && <ShelfPage />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'cost' && <CostPage />}
        {tab === 'me' && <MePage />}
      </div>
      <BottomNav />
      {/* 导入结果统计放在 .home 层（非滚动容器），否则遮罩会被 .home-body 裁剪并跟着滚动 */}
      {statsBook && (
        <ImportStatsModal
          book={statsBook}
          onRead={() => {
            setImportStatsBook(null)
            openBook(statsBook.id)
          }}
          onClose={() => setImportStatsBook(null)}
        />
      )}
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

  // 崩溃哨兵：朗读中会周期写心跳；正常退出/切后台会打 clean 标记。
  // 下次启动若"有心跳无 clean"即上次崩在朗读，把心跳展示出来供定位。
  useEffect(() => {
    installCleanExitMarker()
    const report = consumeCrashReport()
    if (report) {
      // eslint-disable-next-line no-console
      console.error('[crash-sentinel] 上次会话疑似崩溃：', report)
      useAppStore.setState({ lastCrashReport: report })
    }
  }, [])

  // Android 物理返回键：阅读器中返回书架，书架中退出 App
  useEffect(() => {
    let cancelled = false
    let handle: PluginListenerHandle | undefined
    CapacitorApp.addListener('backButton', () => {
      const state = useAppStore.getState()
      if (state.screen === 'reader') {
        state.closeReader()
      } else {
        CapacitorApp.exitApp()
      }
    }).then((h) => {
      if (cancelled) h.remove()
      else handle = h
    })
    return () => {
      cancelled = true
      handle?.remove()
    }
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
