/**
 * 本地神经网络 TTS（sherpa-onnx 原生插件）封装。
 *
 * 与在线 MiniMax 引擎并列：合成链路（按句 segment → blob → 缓存 → 播放 → 高亮）
 * 完全复用，只是"取音频"这一步换成原生推理，不联网、不扣费。
 *
 * 模型清单在 android assets 的 tts-models/manifest.json：
 *   - vits-melo-tts-zh_en 随安装包，开箱即用
 *   - matcha-icefall-zh-baker / kokoro-int8-multi-lang-v1_1 在设置里按需下载
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface LocalModelInfo {
  id: string
  name: string
  desc: string
  speakers: number
  sampleRate: number
  bundled: boolean
  ready: boolean
  loaded: boolean
  totalBytes: number
  installedBytes: number
}

export interface LocalDownloadProgress {
  modelId: string
  file: string
  fileIndex: number
  fileCount: number
  done: number
  total: number
  fileTotal: number
}

interface LocalTtsPluginInterface {
  getModels(): Promise<{ models: LocalModelInfo[] }>
  downloadModel(o: { modelId: string; mirror?: string }): Promise<{ ok: boolean; bytes: number }>
  deleteModel(o: { modelId: string }): Promise<{ ok: boolean }>
  init(o: { modelId: string; threads?: number }): Promise<{
    modelId: string
    sampleRate: number
    speakers: number
  }>
  synth(o: { text: string; sid?: number; speed?: number }): Promise<{
    wavBase64: string
    sampleRate: number
    samples: number
  }>
  release(): Promise<{ ok: boolean }>
  addListener(
    eventName: 'downloadProgress',
    cb: (e: LocalDownloadProgress) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const LocalTts = registerPlugin<LocalTtsPluginInterface>('LocalTts')

/** 默认本地模型（随安装包） */
export const DEFAULT_LOCAL_MODEL = 'vits-melo-tts-zh_en'

/** 网页预览没有原生插件，只能用在线引擎 */
export function isLocalTtsAvailable(): boolean {
  return Capacitor.isNativePlatform()
}

export async function listLocalModels(): Promise<LocalModelInfo[]> {
  if (!isLocalTtsAvailable()) return []
  const r = await LocalTts.getModels()
  return r.models ?? []
}

/** base64 WAV → Blob（播放端 <audio> 与缓存都吃 Blob） */
function base64ToBlob(b64: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: 'audio/wav' })
}

let enginePromise: Promise<void> | null = null
let engineModelId: string | null = null

/**
 * 确保指定模型的引擎已加载。同模型复用实例（加载要 1-2 秒），换模型重新 init。
 * 失败不缓存 Promise，下次调用会重试。
 */
export function ensureLocalEngine(modelId: string): Promise<void> {
  if (!isLocalTtsAvailable()) {
    return Promise.reject(new Error('本地语音只支持 Android 安装包，网页预览请切回在线引擎'))
  }
  if (engineModelId === modelId && enginePromise) return enginePromise
  engineModelId = null
  enginePromise = LocalTts.init({ modelId })
    .then(() => {
      engineModelId = modelId
    })
    .catch((e) => {
      enginePromise = null
      throw e
    })
  return enginePromise
}

/** 合成一句，返回 WAV Blob。调用方负责先 ensureLocalEngine */
export async function synthLocalSegment(
  text: string,
  modelId: string,
  speakerId: number,
): Promise<Blob> {
  await ensureLocalEngine(modelId)
  const r = await LocalTts.synth({ text, sid: speakerId, speed: 1 })
  if (!r?.wavBase64) throw new Error('本地合成返回为空')
  return base64ToBlob(r.wavBase64)
}

export async function downloadLocalModel(
  modelId: string,
  mirror: string | undefined,
): Promise<void> {
  await LocalTts.downloadModel({ modelId, mirror })
}

export async function deleteLocalModel(modelId: string): Promise<void> {
  // 删掉正在用的模型时引擎实例也要释放
  if (engineModelId === modelId) {
    engineModelId = null
    enginePromise = null
  }
  await LocalTts.deleteModel({ modelId })
}

export async function releaseLocalEngine(): Promise<void> {
  engineModelId = null
  enginePromise = null
  if (!isLocalTtsAvailable()) return
  await LocalTts.release()
}

export async function onLocalDownloadProgress(
  cb: (e: LocalDownloadProgress) => void,
): Promise<() => void> {
  if (!isLocalTtsAvailable()) return () => {}
  const handle = await LocalTts.addListener('downloadProgress', cb)
  return () => {
    void handle.remove()
  }
}

/** 给 UI 用的体积格式化 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0B'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}
