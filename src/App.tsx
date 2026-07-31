import { BottomNav } from './components/BottomNav'
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
        {tab === 'me' && <MePage />}
      </div>
      <BottomNav />
    </div>
  )
}

export default function App() {
  const screen = useAppStore((s) => s.screen)

  return (
    <div className="app-stage">
      <div className="phone-shell">
        <div className="phone-notch" />
        <div className="phone-screen">
          <Home />
          {screen === 'reader' && <ReaderPage />}
        </div>
        <aside className="preview-hint">
          <h3>界面预览说明</h3>
          <ul>
            <li>左侧为手机框，模拟安卓界面</li>
            <li>书架三列封面，参考起点布局</li>
            <li>点封面进入阅读器</li>
            <li>点屏幕中部唤出底部菜单</li>
            <li>「听书」可语音朗读并记进度</li>
            <li>「足迹」查看历史朗读位置</li>
          </ul>
        </aside>
      </div>
    </div>
  )
}
