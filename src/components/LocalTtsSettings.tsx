import { useEffect, useRef, useState } from 'react'
import type { ReaderSettings } from '../types'
import {
  DEFAULT_LOCAL_MODEL,
  deleteLocalModel,
  downloadLocalModel,
  formatBytes,
  isLocalTtsAvailable,
  listLocalModels,
  onLocalDownloadProgress,
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
 * 本地 TTS 模型管理：选用 / 下载（带进度）/ 删除 / 发音人 / 试听。
 * 模型清单与就绪状态来自原生插件（assets 里的 manifest.json + 已下载目录）。
 */
export function LocalTtsSettings({ settings, onUpdateSettings }: Props) {
  const available = isLocalTtsAvailable()
  const [models, setModels] = useState<LocalModelInfo[]>([])
  const [progress, setProgress] = useState<{
    modelId: string
    done: number
    total: number
    file: string
  } | null>(null)
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

  useEffect(() => {
    let un: (() => void) | null = null
    void onLocalDownloadProgress((e) => {
      setProgress({ modelId: e.modelId, done: e.done, total: e.total, file: e.file })
      if (e.total > 0 && e.done >= e.total) {
        setProgress(null)
        refresh()
      }
    }).then((f) => {
      un = f
    })
    return () => {
      un?.()
    }
  }, [])

  useEffect(() => () => audioRef.current?.pause(), [])

  const currentId = settings.localModelId || DEFAULT_LOCAL_MODEL
  const current = models.find((m) => m.id === currentId)

  const onDownload = async (id: string) => {
    setBusy(id)
    setError('')
    try {
      await downloadLocalModel(id, undefined)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const onDelete = async (id: string) => {
    setBusy(id)
    setError('')
    try {
      await deleteLocalModel(id)
      if (currentId === id) onUpdateSettings({ localModelId: DEFAULT_LOCAL_MODEL, localSpeakerId: 0 })
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const onAudition = async () => {
    setBusy('audition')
    setError('')
    try {
      const blobs = await synthLocalBlock(
        AUDITION_TEXT,
        currentId,
        settings.localSpeakerId ?? 0,
        [0],
      )
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
        const pct =
          progress?.modelId === m.id && progress.total > 0
            ? Math.min(100, Math.round((progress.done / progress.total) * 100))
            : null
        return (
          <div
            key={m.id}
            className="voice-install-box"
            style={selected ? { outline: '1px solid rgba(255,138,128,0.6)' } : undefined}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
              <strong style={{ color: selected ? '#ff8a80' : undefined }}>{m.name}</strong>
              <span style={{ opacity: 0.8, whiteSpace: 'nowrap' }}>
                {m.bundled
                  ? `随安装包 ${formatBytes(m.totalBytes)}`
                  : m.ready
                    ? `已下载 ${formatBytes(m.installedBytes)}`
                    : `需下载 ${formatBytes(m.totalBytes)}`}
              </span>
            </div>
            <p style={{ margin: '4px 0 6px', fontSize: 11, lineHeight: 1.5, opacity: 0.8 }}>{m.desc}</p>

            {pct != null && progress && (
              <div style={{ fontSize: 11, opacity: 0.85 }}>
                <div
                  style={{
                    height: 4,
                    borderRadius: 2,
                    background: 'rgba(255,255,255,0.15)',
                    overflow: 'hidden',
                    margin: '2px 0 4px',
                  }}
                >
                  <div style={{ width: `${pct}%`, height: '100%', background: '#ff8a80' }} />
                </div>
                {pct}% · {progress.file}
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                type="button"
                className="voice-select"
                style={{ width: 'auto', flex: 1, padding: '6px 8px', fontSize: 12 }}
                disabled={!m.ready || busy != null}
                onClick={() => onUpdateSettings({ localModelId: m.id, localSpeakerId: 0 })}
              >
                {selected ? '当前使用' : m.ready ? '选用' : '先下载'}
              </button>
              {!m.bundled && m.ready && (
                <button
                  type="button"
                  className="voice-select"
                  style={{ width: 'auto', padding: '6px 8px', fontSize: 12 }}
                  disabled={busy != null}
                  onClick={() => void onDelete(m.id)}
                >
                  删除
                </button>
              )}
              {!m.ready && (
                <button
                  type="button"
                  className="voice-select"
                  style={{ width: 'auto', padding: '6px 8px', fontSize: 12 }}
                  disabled={busy != null}
                  onClick={() => void onDownload(m.id)}
                >
                  {busy === m.id ? '下载中…' : '下载'}
                </button>
              )}
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

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          type="button"
          className="voice-select"
          style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }}
          disabled={busy != null || !current?.ready}
          onClick={() => void onAudition()}
        >
          {busy === 'audition' ? '合成中…' : '试听当前模型'}
        </button>
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          {current?.ready ? `${current.sampleRate / 1000}kHz` : '模型未就绪'}
        </span>
      </div>

      {error && <span style={{ fontSize: 11, color: '#ff8a80' }}>{error}</span>}
    </div>
  )
}
