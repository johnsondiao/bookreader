import { useEffect, useRef, useState } from 'react'
import type { ReaderSettings } from '../types'
import {
  formatBytes,
  isLocalTtsAvailable,
  listLocalModels,
  resolveLocalModelId,
  synthLocalBlock,
  type LocalModelInfo,
} from '../utils/localTts'

interface Props {
  settings: ReaderSettings
  onUpdateSettings: (p: Partial<ReaderSettings>) => void
}

const AUDITION_TEXT = '朗阅本地语音试听。这一句完全由手机上的神经网络合成，不联网，也不花一分钱。'

/** Android WebView 的媒体管线不吃 blob: URL，试听要走 data URI */
function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('读取音频失败'))
    r.readAsDataURL(blob)
  })
}

/**
 * 本地 TTS 模型管理：选用 / 发音人 / 逐模型试听。
 * 模型全部随安装包（assets/tts-models），没有下载与删除；就绪状态来自原生插件校验。
 * 每个模型一行、带独立"试听"按钮——真机排查哪个模型能响，一眼便知。
 */
export function LocalTtsSettings({ settings, onUpdateSettings }: Props) {
  const available = isLocalTtsAvailable()
  const [models, setModels] = useState<LocalModelInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const refresh = () => {
    void listLocalModels()
      .then(setModels)
      .catch(() => setModels([]))
  }

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => () => audioRef.current?.pause(), [])

  const currentId = resolveLocalModelId(settings.localModelId)
  const current = models.find((m) => m.id === currentId)

  /** 逐模型试听：非当前模型用 0 号发音人；当前模型沿用所选发音人，方便调音色 */
  const onAudition = async (m: LocalModelInfo) => {
    const key = `audition:${m.id}`
    setBusy(key)
    setError('')
    try {
      const sid = m.id === currentId ? settings.localSpeakerId ?? 0 : 0
      const blobs = await synthLocalBlock(AUDITION_TEXT, m.id, sid, [0])
      audioRef.current?.pause()
      const a = new Audio(await blobToDataUri(blobs[0]))
      audioRef.current = a
      await a.play()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (!available) {
    return (
      <div className="voice-install-box">
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
          本地神经网络语音（sherpa-onnx）只在 Android 安装包内可用；网页预览请切到在线引擎。
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {models.map((m) => {
        const selected = m.id === currentId
        const auditioning = busy === `audition:${m.id}`
        return (
          <div
            key={m.id}
            className="voice-install-box"
            style={selected ? { outline: '1px solid rgba(255,138,128,0.6)' } : undefined}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
              <strong style={{ color: selected ? '#ff8a80' : undefined }}>{m.name}</strong>
              <span style={{ opacity: 0.8, whiteSpace: 'nowrap' }}>
                {m.ready
                  ? `随安装包 ${formatBytes(m.totalBytes)}`
                  : `包内校验失败 ${formatBytes(m.totalBytes)}`}
              </span>
            </div>
            <p style={{ margin: '4px 0 6px', fontSize: 11, lineHeight: 1.5, opacity: 0.8 }}>{m.desc}</p>

            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                type="button"
                className="voice-select"
                style={{ width: 'auto', flex: 1, padding: '6px 8px', fontSize: 12 }}
                disabled={!m.ready || busy != null}
                onClick={() => onUpdateSettings({ localModelId: m.id, localSpeakerId: 0 })}
              >
                {selected ? '当前使用' : '选用'}
              </button>
              <button
                type="button"
                className="voice-select"
                style={{ width: 'auto', padding: '6px 8px', fontSize: 12 }}
                disabled={!m.ready || busy != null}
                onClick={() => void onAudition(m)}
              >
                {auditioning ? '合成中…' : '试听'}
              </button>
            </div>
          </div>
        )
      })}

      {current && current.speakers > 1 && (
        <div className="row" style={{ padding: 0 }}>
          <span>发音人</span>
          <div className="stepper">
            <button
              type="button"
              onClick={() =>
                onUpdateSettings({ localSpeakerId: Math.max(0, (settings.localSpeakerId ?? 0) - 1) })
              }
            >
              −
            </button>
            <span>
              {(settings.localSpeakerId ?? 0) + 1}/{current.speakers}
            </span>
            <button
              type="button"
              onClick={() =>
                onUpdateSettings({
                  localSpeakerId: Math.min(current.speakers - 1, (settings.localSpeakerId ?? 0) + 1),
                })
              }
            >
              +
            </button>
          </div>
        </div>
      )}

      {error && <span style={{ fontSize: 11, color: '#ff8a80' }}>{error}</span>}
    </div>
  )
}
