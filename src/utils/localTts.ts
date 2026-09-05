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
    pcmBase64: string
    sampleRate: number
    samples: number
  }>
  release(): Promise<{ ok: boolean }>
  getNativeLog(): Promise<{ log: string }>
  clearNativeLog(): Promise<{ ok: boolean }>
  addListener(
    eventName: 'downloadProgress',
    cb: (e: LocalDownloadProgress) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const LocalTts = registerPlugin<LocalTtsPluginInterface>('LocalTts')

/** 默认本地模型：kokoro int8（音质最好、103 音色）；melo 已移除（中文韵律偏怪） */
export const DEFAULT_LOCAL_MODEL = 'kokoro-int8-multi-lang-v1_1'

/** 随包模型白名单；旧设置里残留的已移除模型（如 melo）回落到默认 */
export const SUPPORTED_LOCAL_MODELS = ['kokoro-int8-multi-lang-v1_1', 'matcha-icefall-zh-baker']

export function resolveLocalModelId(id: string | undefined): string {
  return id && SUPPORTED_LOCAL_MODELS.includes(id) ? id : DEFAULT_LOCAL_MODEL
}

/** 网页预览没有原生插件，只能用在线引擎 */
export function isLocalTtsAvailable(): boolean {
  return Capacitor.isNativePlatform()
}

export async function listLocalModels(): Promise<LocalModelInfo[]> {
  if (!isLocalTtsAvailable()) return []
  const r = await LocalTts.getModels()
  return r.models ?? []
}

/** base64 → 字节（显式 ArrayBuffer：TS6 的 BlobPart 不接受 ArrayBufferLike 视图） */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** PCM16 小端块拼成 WAV Blob（头在 JS 侧套，原生只流式回传 PCM） */
function wavBlobFromPcm(parts: Uint8Array<ArrayBuffer>[], sampleRate: number): Blob {
  let total = 0
  for (const p of parts) total += p.byteLength
  const header = new DataView(new ArrayBuffer(44))
  const wr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) header.setUint8(off + i, s.charCodeAt(i))
  }
  wr(0, 'RIFF')
  header.setUint32(4, 36 + total, true)
  wr(8, 'WAVE')
  wr(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true) // PCM
  header.setUint16(22, 1, true) // mono
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * 2, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  wr(36, 'data')
  header.setUint32(40, total, true)
  return new Blob([header.buffer, ...parts], { type: 'audio/wav' })
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

/**
 * 合成一整块（模型看到整块上下文 → 语调连贯），再按 cuts 把 PCM 切回每句 WAV。
 * cuts[i] = 第 i 句起始字符在块内的比例（cuts[0] 恒为 0）。
 * 原生端已抽采样到 22.05k 并整块 base64 回传（无回调路径，避开真机崩溃的 JNI 回调）。
 */
export async function synthLocalBlock(
  text: string,
  modelId: string,
  speakerId: number,
  cuts: number[],
): Promise<Blob[]> {
  await ensureLocalEngine(modelId)
  const r = await LocalTts.synth({ text, sid: speakerId, speed: 1 })
  if (!r?.pcmBase64) throw new Error('本地合成未返回音频')
  const parts = [base64ToBytes(r.pcmBase64)]
  const total = parts[0].byteLength
  const sliceRange = (a: number, b: number): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(new ArrayBuffer(Math.max(0, b - a)))
    out.set(parts[0].subarray(a, b), 0)
    return out
  }
  const blobs: Blob[] = []
  for (let i = 0; i < cuts.length; i++) {
    const endF = i + 1 < cuts.length ? cuts[i + 1] : 1
    // 对齐到 4 字节（= 2 个 PCM16 样本），避免切在样本中间产生爆音
    const a = Math.min(total, Math.round((cuts[i] * total) / 4) * 4)
    const b = Math.min(total, Math.max(a + 4, Math.round((endF * total) / 4) * 4))
    blobs.push(wavBlobFromPcm([sliceRange(a, b)], r.sampleRate))
  }
  return blobs
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

/** 原生层日志（cacheDir/localtts.log）：闪退后进程没了文件还在 */
export async function getNativeLog(): Promise<string> {
  if (!isLocalTtsAvailable()) return ''
  try {
    const r = await LocalTts.getNativeLog()
    return r.log ?? ''
  } catch {
    return ''
  }
}

/** 熔断处理后清空原生日志 */
export async function clearNativeLog(): Promise<void> {
  if (!isLocalTtsAvailable()) return
  try {
    await LocalTts.clearNativeLog()
  } catch {
    /* ignore */
  }
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
