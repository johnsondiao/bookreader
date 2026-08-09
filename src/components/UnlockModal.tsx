import { useState } from 'react'

interface UnlockModalProps {
  error: string
  loading: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
}

export function UnlockModal(props: UnlockModalProps) {
  const { error, loading, onSubmit, onCancel } = props
  const [password, setPassword] = useState('')

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!password || loading) return
    onSubmit(password)
  }

  return (
    <div className="tts-unlock-mask" onClick={onCancel}>
      <form
        className="tts-unlock-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3>语音功能解锁</h3>
        <p className="tts-unlock-desc">首次使用在线语音需输入密码，验证后自动保存，之后不再询问。</p>
        <input
          className="tts-unlock-input"
          type="password"
          autoFocus
          autoComplete="off"
          placeholder="请输入密码"
          value={password}
          disabled={loading}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <span className="tts-unlock-error">{error}</span>}
        <div className="tts-unlock-buttons">
          <button type="button" className="tts-unlock-btn cancel" onClick={onCancel} disabled={loading}>
            取消
          </button>
          <button type="submit" className="tts-unlock-btn ok" disabled={loading || !password}>
            {loading ? '解锁中…' : '解锁'}
          </button>
        </div>
      </form>
    </div>
  )
}