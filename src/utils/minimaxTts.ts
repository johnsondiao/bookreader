/**
 * MiniMax 在线语音合成客户端 —— 同步 T2A v2（speech-2.8 Turbo）。
 *
 * 流程（见 https://platform.minimaxi.com/document/T2A%20V2 ）：
 *   POST /v1/t2a_v2  一次请求直接返回 base64 音频，无需轮询/下载。
 *   相比异步省掉轮询开销（约 10-20s），单次支持 ≤5 万字符。
 *
 * 鉴权：Header `Authorization: Bearer <MINMAXKEY>`，v2 接口无需 GroupId。
 *
 * 网络通道：Android 原生走 CapacitorHttp（绕过 WebView CORS）；浏览器开发用 fetch。
 * 注意：浏览器直连 api.minimaxi.com 可能被 CORS 拦截，正式环境以 Android App 为准。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { agentLog } from './agentLog'
import { getTtsKey } from './ttsKeyStore'

const API_BASE = 'https://api.minimaxi.com'
/**
 * Turbo 系列模型：同步合成，速度快、性价比高。
 * 官方定价见 https://platform.minimaxi.com/document/Price
 *   Turbo: ¥400 / 200万字符 = ¥200/百万字符 = ¥2/万字
 *   HD:    ¥700 / 200万字符 = ¥350/百万字符 = ¥3.5/万字
 */
const MODEL = 'speech-2.8'
/** Turbo 系列单价：¥200 每百万字符（=¥2/万字） */
export const TTS_COST_PER_MILLION = 200

export function estimateTtsCost(charCount: number): number {
  return (charCount / 1_000_000) * TTS_COST_PER_MILLION
}

export type SynthStage = 'synthesizing' | 'done'
export type SynthProgress = {
  stage: SynthStage
  /** 0~1 */
  progress: number
  message: string
}

interface BaseResp {
  base_resp?: { status_code: number; status_msg: string }
}
interface SyncResp extends BaseResp {
  /** 音频数据（hex 或 base64 编码的字符串） */
  data?: string
  extra_info?: {
    audio_length?: number
    audio_size?: number
    audio_sample_rate?: number
    audio_bitrate?: number
  }
}

/** 原生用 CapacitorHttp（绕 CORS），Web 用 fetch。同步合成大文本耗时长，超时设 180s。 */
async function httpPostSync(path: string, body: unknown): Promise<SyncResp> {
  const key = await getTtsKey() // 未解锁时抛 TtsKeyLockedError，由上层弹密码框
  const url = `${API_BASE}${path}`
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
  if (Capacitor.isNativePlatform()) {
    const resp = await CapacitorHttp.request({
      url,
      method: 'POST',
      headers,
      data: body,
      responseType: 'json',
      connectTimeout: 30000,
      readTimeout: 180000, // 5 万字同步合成可能要 60-90s，留足余量
    })
    const data = typeof resp.data === 'string' ? safeJson(resp.data) : resp.data
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `MiniMax POST ${path} 失败: HTTP ${resp.status} ${data?.base_resp?.status_msg ?? ''}`,
      )
    }
    return data as SyncResp
  }
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const data = (await r.json().catch(() => ({}))) as SyncResp
  if (!r.ok) {
    throw new Error(
      `MiniMax POST ${path} 失败: HTTP ${r.status} ${data?.base_resp?.status_msg ?? ''}`,
    )
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

/** hex 字符串 → ArrayBuffer */
function hexToBuf(hex: string): ArrayBuffer {
  const clean = hex.replace(/\s+/g, '')
  const buf = new ArrayBuffer(clean.length / 2)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return buf
}

/** base64 字符串 → ArrayBuffer */
function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return buf
}

/**
 * 合成一段文本（≤ 5 万字）为 mp3 Blob。
 * 调用方负责把长章节切成 ≤ MAX_CHUNK_CHARS 的块，逐块调用本函数。
 *
 * 同步接口：一次 POST 直接返回音频，无需轮询。
 * 大文本耗时长（5 万字约 60-90s），调用方需在进度回调里给用户反馈。
 */
export async function synthesizeChunk(
  text: string,
  voiceId: string,
  onProgress: (p: SynthProgress) => void,
  isAlive: () => void,
): Promise<Blob> {
  isAlive()
  onProgress({ stage: 'synthesizing', progress: 0.3, message: '在线合成中…（同步）' })
  agentLog('minimaxTts:sync', 'request start', { chars: text.length, voiceId }, 'C')

  const resp = await httpPostSync('/v1/t2a_v2', {
    model: MODEL,
    text,
    voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 1 },
    audio_setting: {
      audio_sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
    language_boost: 'auto',
  })

  if (resp.base_resp?.status_code !== 0 && resp.base_resp?.status_code !== undefined) {
    throw new Error(`MiniMax 合成失败: ${resp.base_resp.status_msg}`)
  }

  const audioStr = resp.data
  if (!audioStr) throw new Error('MiniMax 同步合成未返回音频数据')

  // 兼容 hex（默认）和 base64 两种编码
  const isHex = /^[0-9a-fA\s]+$/i.test(audioStr)
  const buf = isHex ? hexToBuf(audioStr) : b64ToBuf(audioStr)
  const blob = new Blob([buf], { type: 'audio/mpeg' })

  isAlive()
  onProgress({ stage: 'done', progress: 1, message: '合成完成' })
  agentLog(
    'minimaxTts:sync',
    'success',
    { chars: text.length, bytes: buf.byteLength, audioLen: resp.extra_info?.audio_length },
    'C',
  )
  return blob
}
