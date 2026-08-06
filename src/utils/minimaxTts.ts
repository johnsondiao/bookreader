/**
 * MiniMax 在线语音合成客户端 —— 异步长文本 T2A（speech-2.8-turbo）。
 *
 * 流程（见 https://platform.minimaxi.com/docs/api-reference/speech-t2a-async-create ）：
 *   1. POST /v1/t2a_async_v2           创建任务 → task_id
 *   2. GET  /v1/query/t2a_async_query_v2  轮询状态，Success 后拿到 file_id
 *   3. GET  /v1/files/retrieve?file_id=  拿到 download_url，下载 mp3 Blob
 *
 * 鉴权：Header `Authorization: Bearer <MINMAXKEY>`，新版 v2 接口无需 GroupId。
 *
 * 网络通道：Android 原生走 CapacitorHttp（绕过 WebView CORS）；浏览器开发用 fetch。
 * 注意：浏览器直连 api.minimaxi.com 可能被 CORS 拦截，正式环境以 Android App 为准。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { agentLog } from './agentLog'
import { getTtsKey } from './ttsKeyStore'

const API_BASE = 'https://api.minimaxi.com'
/** 标准版 TTS：¥2 / 百万字（长文本异步）。turbo 版计费更高且队列慢。 */
const MODEL = 'speech-2.8'
/** 单价：¥2 每百万字符 */
export const TTS_COST_PER_MILLION = 2

export function estimateTtsCost(charCount: number): number {
  return (charCount / 1_000_000) * TTS_COST_PER_MILLION
}

export type SynthStage = 'create' | 'polling' | 'downloading' | 'done'
export type SynthProgress = {
  stage: SynthStage
  /** 0~1 */
  progress: number
  message: string
}

interface BaseResp {
  base_resp?: { status_code: number; status_msg: string }
}
interface CreateResp extends BaseResp {
  task_id: number
  file_id: number
}
interface QueryResp extends BaseResp {
  task_id: number
  status: 'Processing' | 'Success' | 'Failed' | 'Expired'
  file_id?: number
}
interface RetrieveResp extends BaseResp {
  file?: { file_id: string; download_url: string; filename?: string; bytes?: number }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 原生用 CapacitorHttp（绕 CORS），Web 用 fetch */
async function httpJson(method: string, path: string, body?: unknown): Promise<any> {
  const key = await getTtsKey() // 未解锁时抛 TtsKeyLockedError，由上层弹密码框
  const url = `${API_BASE}${path}`
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
  if (Capacitor.isNativePlatform()) {
    const resp = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: body ?? undefined,
      responseType: 'json',
      connectTimeout: 30000,
      readTimeout: 60000,
    })
    const data = typeof resp.data === 'string' ? safeJson(resp.data) : resp.data
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`MiniMax ${method} ${path} 失败: HTTP ${resp.status} ${data?.base_resp?.status_msg ?? ''}`)
    }
    return data
  }
  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    throw new Error(`MiniMax ${method} ${path} 失败: HTTP ${r.status} ${data?.base_resp?.status_msg ?? ''}`)
  }
  return data
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/** 下载音频二进制：原生 CapacitorHttp 返回 base64 字符串，Web 返回 Blob */
async function httpGetBlob(url: string): Promise<Blob> {
  if (Capacitor.isNativePlatform()) {
    const resp = await CapacitorHttp.request({
      url,
      method: 'GET',
      responseType: 'blob',
      connectTimeout: 30000,
      readTimeout: 180000,
    })
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`音频下载失败: HTTP ${resp.status}`)
    }
    // 原生层 blob 响应 data 为 base64 字符串；Web 层为 Blob
    if (resp.data instanceof Blob) return resp.data
    if (typeof resp.data === 'string' && resp.data.length > 0) {
      const bin = atob(resp.data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type: 'audio/mpeg' })
    }
    throw new Error('音频下载响应为空')
  }
  const r = await fetch(url)
  if (!r.ok) throw new Error(`音频下载失败: HTTP ${r.status}`)
  return await r.blob()
}

/** 1. 创建异步合成任务 */
async function createT2aTask(text: string, voiceId: string): Promise<{ taskId: number; fileId: number }> {
  const d = (await httpJson('POST', '/v1/t2a_async_v2', {
    model: MODEL,
    text,
    voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 1 },
    audio_setting: { audio_sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    language_boost: 'auto',
  })) as CreateResp
  if (d.base_resp?.status_code !== 0 && d.base_resp?.status_code !== undefined) {
    throw new Error(`MiniMax 创建任务失败: ${d.base_resp.status_msg}`)
  }
  if (!d.task_id) throw new Error('MiniMax 创建任务未返回 task_id')
  return { taskId: d.task_id, fileId: d.file_id }
}

/** 2. 轮询任务状态，成功返回最终 file_id */
async function pollTask(
  taskId: number,
  onProgress: (p: SynthProgress) => void,
  isAlive: () => void,
): Promise<number> {
  const interval = 3000
  const maxAttempts = 240 // 约 12 分钟
  for (let i = 0; i < maxAttempts; i++) {
    isAlive()
    const d = (await httpJson('GET', `/v1/query/t2a_async_query_v2?task_id=${taskId}`)) as QueryResp
    if (d.status === 'Success') {
      const fid = d.file_id
      if (!fid) throw new Error('MiniMax 任务成功但未返回 file_id')
      return fid
    }
    if (d.status === 'Failed' || d.status === 'Expired') {
      throw new Error(`MiniMax 合成任务${d.status}: ${d.base_resp?.status_msg ?? ''}`)
    }
    onProgress({
      stage: 'polling',
      progress: Math.min(0.9, 0.1 + i / 60),
      message: `在线合成中…（已等待 ${i * 3}s）`,
    })
    await sleep(interval)
  }
  throw new Error('MiniMax 合成超时（>12 分钟）')
}

/** 3. 检索文件下载地址并下载音频 Blob */
async function downloadAudio(fileId: number): Promise<Blob> {
  const d = (await httpJson('GET', `/v1/files/retrieve?file_id=${fileId}`)) as RetrieveResp
  const url = d.file?.download_url
  if (!url) throw new Error('MiniMax 未返回音频下载地址')
  return await httpGetBlob(url)
}

/**
 * 合成一段文本（≤ 5 万字）为 mp3 Blob。
 * 调用方负责把长章节切成 ≤ MAX_CHUNK_CHARS 的块，逐块调用本函数。
 */
export async function synthesizeChunk(
  text: string,
  voiceId: string,
  onProgress: (p: SynthProgress) => void,
  isAlive: () => void,
): Promise<Blob> {
  isAlive()
  onProgress({ stage: 'create', progress: 0.05, message: '提交在线合成任务…' })
  const { taskId } = await createT2aTask(text, voiceId)
  agentLog('minimaxTts:create', 'task created', { taskId, chars: text.length, voiceId }, 'C')
  isAlive()
  onProgress({ stage: 'polling', progress: 0.1, message: '排队合成中…' })
  const fileId = await pollTask(taskId, onProgress, isAlive)
  agentLog('minimaxTts:poll', 'success', { taskId, fileId }, 'C')
  isAlive()
  onProgress({ stage: 'downloading', progress: 0.95, message: '下载音频…' })
  const blob = await downloadAudio(fileId)
  onProgress({ stage: 'done', progress: 1, message: '合成完成' })
  return blob
}
