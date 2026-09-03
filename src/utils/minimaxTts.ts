/**
 * MiniMax 在线语音合成客户端 —— 同步 T2A v2（speech-2.8-turbo）。
 *
 * 流程（见 同步语音合成 HTTP 接口文档）：
 *   POST /v1/t2a_v2  一次请求直接返回 base64/hex 音频，无需轮询/下载。
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
 * TTS 模型选择：
 *
 *   speech-2.8-turbo  — Turbo 极速版，文档主推荐模型。
 *
 *   注意：纯 "speech-2.8" 不带后缀不存在，接口会直接报 invalid params；
 *         必须为 "-turbo" 或 "-hd"。
 *
 * 官方定价（平台 → 价格说明页）：
 *   Turbo:¥400 / 200万字符 = ¥200/百万字符 = ¥2/万字
 *   HD:   ¥700 / 200万字符 = ¥350/百万字符 = ¥3.5/万字
 */
const MODEL = 'speech-2.8-turbo'
/** Turbo 系列单价：¥200 每百万字符（=¥2/万字）  */
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
/**
 * t2a_v2 同步接口响应结构（实测自 Java 示例 + 群文档）：
 *   data: { audio: "<hex/base64 字符串>" }    —— data 是对象，不是字符串！
 *   extra_info: { audio_length, audio_sample_rate, audio_size, bitrate }
 *   base_resp: { status_code, status_msg }
 *
 * 注意：历史上不同接口/不同时段文档对 data 字段描述不一致，
 * 代码里同时兼容 data={audio} 和 data=音频字符串 两种形式，避免再踩坑。
 */
interface SyncResp extends BaseResp {
  data?: string | { audio?: string } | null
  extra_info?: {
    audio_length?: number
    audio_size?: number
    audio_sample_rate?: number
    bitrate?: number
  }
}

/** 原生用 CapacitorHttp（绕 CORS），Web 用 fetch。同步合成大文本耗时长，超时设 60s。 */
async function httpPostSync(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<SyncResp> {
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
      connectTimeout: 20000,
      readTimeout: 60000, // 单句一般 < 10s，60s 足够
    })
    const data = typeof resp.data === 'string' ? safeJson(resp.data) : resp.data
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `MiniMax POST ${path} 失败: HTTP ${resp.status} ${data?.base_resp?.status_msg ?? ''}`,
      )
    }
    return (data ?? {}) as SyncResp
  }
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
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

/**
 * 安全地把任意值转换为原生 string，杜绝 "x.trim is not a function"。
 * 背景：CapacitorHttp / 某些 JSON 层会把字符串包装成 String 对象（typeof === 'object'），
 * 直接调用 .trim() 会报错；用 String(x) 可以强制解包为 primitive string。
 */
function toPrimitiveString(x: unknown): string {
  if (typeof x === 'string') return x
  if (x == null) return ''
  if (x instanceof String) return String(x)
  try {
    return String(x)
  } catch {
    return ''
  }
}

/**
 * 判断音频数据的编码格式。
 *
 * MiniMax T2A v2 返回的 data 字段可能是 hex 或 base64：
 *   - hex:      仅含 0-9 a-f A-F 空白，长度为偶数（每字节 2 字符）
 *   - base64:   含 + / = 或 G-Z 大写字母（超出 hex 范围）
 *                或 URL-safe 变体（- _ 替代 + /）
 *
 * 关键：不能仅用 /^[0-9a-fA\s]+$/i 判定，因为 base64 字符串碰巧全是
 * a-f 字符时会被误判为 hex，导致解码失败。
 */
function detectAudioEncoding(s: unknown): 'hex' | 'base64' {
  const clean = toPrimitiveString(s).trim()
  if (!clean) return 'base64'
  // base64 特有的字符：+ / = URL-safe 的 - _ 或 G-Z（超出 hex 的大写字母）
  // 如果含有这些字符，一定是 base64
  if (/[+=/\-_]|[G-Z]/.test(clean)) return 'base64'
  // 纯 hex 字符且长度为偶数（每字节 2 hex 字符）
  const hexOnly = clean.replace(/\s+/g, '')
  if (/^[0-9a-fA]+$/i.test(hexOnly) && hexOnly.length % 2 === 0) return 'hex'
  // 无法确定时默认 base64（MP3 接口大概率返回 base64）
  return 'base64'
}

/** hex 字符串 → ArrayBuffer（健壮版，支持空格换行等空白） */
function hexToBuf(hex: unknown): ArrayBuffer {
  const clean = toPrimitiveString(hex).replace(/\s+/g, '')
  const buf = new ArrayBuffer(Math.floor(clean.length / 2))
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) {
    const hi = parseInt(clean[i * 2], 16)
    const lo = parseInt(clean[i * 2 + 1], 16)
    bytes[i] = (hi << 4) | lo
  }
  return buf
}

/**
 * base64 字符串 → ArrayBuffer（健壮版）。
 * 处理：
 *   - URL-safe base64:  - → +, _ → /
 *   - 缺失 padding:  补 = 至 4 的倍数
 *   - data URI 前缀:  去掉 data:...;base64, 前缀
 *   - 空白字符:  自动剔除
 *   - 入参类型混乱:  强制 String() 解包，避免 .trim is not a function
 */
function b64ToBuf(b64: unknown): ArrayBuffer {
  let s = toPrimitiveString(b64).trim()
  // 去掉 data URI 前缀
  const dataUriMatch = s.match(/^data:[^;]+;base64,(.+)$/i)
  if (dataUriMatch) s = dataUriMatch[1]
  // URL-safe base64 → 标准 base64
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  // 去除空白
  s = s.replace(/\s+/g, '')
  // 补齐 padding
  const padLen = s.length % 4
  if (padLen > 0) s += '='.repeat(4 - padLen)
  const bin = atob(s)
  const buf = new ArrayBuffer(bin.length)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return buf
}

/**
 * 将 API 返回的音频字符串解码为 ArrayBuffer。
 * 自动检测 hex / base64 编码，一种失败时回退到另一种。
 */
function decodeAudioData(audioStr: unknown): ArrayBuffer {
  const str = toPrimitiveString(audioStr)
  const encoding = detectAudioEncoding(str)
  agentLog('minimaxTts:decode', 'encoding detected', { encoding, len: str.length, preview: str.slice(0, 60), wasObj: typeof audioStr !== 'string' }, 'D')
  try {
    const buf = encoding === 'hex' ? hexToBuf(str) : b64ToBuf(str)
    if (buf.byteLength > 0) return buf
    agentLog('minimaxTts:decode', 'primary decode returned 0 bytes, trying fallback')
  } catch (e) {
    agentLog('minimaxTts:decode', `primary decode failed: ${e}, trying fallback`)
  }
  // 回退：尝试另一种编码
  try {
    const fallback = encoding === 'hex' ? b64ToBuf(str) : hexToBuf(str)
    if (fallback.byteLength > 0) {
      agentLog('minimaxTts:decode', 'fallback decode succeeded', { bytes: fallback.byteLength })
      return fallback
    }
  } catch (e2) {
    agentLog('minimaxTts:decode', `fallback also failed: ${e2}`)
  }
  throw new Error(`音频解码失败：hex 和 base64 均无法解析 (原始长度=${str.length})`)
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
  registerAbort?: (fn: () => void) => void,
  languageBoost: string = 'auto',
): Promise<Blob> {
  isAlive()
  onProgress({ stage: 'synthesizing', progress: 0.3, message: '在线合成中…（同步）' })
  agentLog('minimaxTts:sync', 'request start', { chars: text.length, voiceId }, 'C')

  // AbortController：Web 端可被 stop() 立即中断 HTTP 请求
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  if (registerAbort && controller) {
    registerAbort(() => {
      try { controller.abort() } catch { /* ignore */ }
    })
  }

  // 请求体：按 speech-2.8-turbo 官方标准格式。
  // 注意：不要再传顶层 voice_id/speed/vol/pitch 和 timbre_weights（旧 speech-02 风格，
  // 与 voice_setting 冲突会导致服务端行为不可预期）；
  // language_boost 由调用方显式指定（普通话传 'Chinese'），不能用 'auto'：
  // auto 会把网文文本误判成粤语等其他语种。
  const resp = await httpPostSync('/v1/t2a_v2', {
    model: MODEL,
    text,
    stream: false,
    voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
    language_boost: languageBoost,
  }, controller?.signal)

  if (resp.base_resp?.status_code !== 0 && resp.base_resp?.status_code !== undefined) {
    throw new Error(`MiniMax 合成失败: ${resp.base_resp.status_msg}`)
  }

  /** 递归查找对象中最长的字符串（音频数据一定是最长的那个），最深 3 层 */
  function findLongestString(obj: any, depth = 0, maxDepth = 3): { value: string; path: string } {
    let best: { value: string; path: string } = { value: '', path: '' }
    if (!obj || depth >= maxDepth) return best
    if (typeof obj === 'string') return { value: obj, path: '' }
    if (typeof obj !== 'object') return best
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (typeof v === 'string' && v.length > best.value.length) {
        best = { value: v, path: k }
      } else if (v && typeof v === 'object') {
        const sub = findLongestString(v, depth + 1, maxDepth)
        if (sub.value.length > best.value.length) {
          best = { value: sub.value, path: sub.path ? `${k}.${sub.path}` : k }
        }
      }
    }
    return best
  }

  // —— 日志：查看真实响应结构的字段名 ——
  const raw = resp as any
  const respKeys = Object.keys(raw)
  const respTypes: Record<string, string> = {}
  for (const k of respKeys) respTypes[k] = typeof raw[k]
  // 安全地 dump 出响应的前 4000 字符（足以看到结构，又不刷屏）
  let fullDump = ''
  try {
    const redacted: any = {}
    for (const k of respKeys) {
      const v = raw[k]
      if (typeof v === 'string' && v.length > 200) {
        redacted[k] = `[string len=${v.length}] ${v.slice(0, 80)}...`
      } else if (v && typeof v === 'object') {
        // 对嵌套对象也做同样处理
        redacted[k] = {}
        for (const kk of Object.keys(v)) {
          const vv = v[kk]
          if (typeof vv === 'string' && vv.length > 200) {
            redacted[k][kk] = `[string len=${vv.length}] ${vv.slice(0, 80)}...`
          } else {
            redacted[k][kk] = vv
          }
        }
      } else {
        redacted[k] = v
      }
    }
    fullDump = JSON.stringify(redacted, null, 2)
  } catch (dumpErr) {
    fullDump = `[dump 失败: ${dumpErr}]`
  }
  agentLog('minimaxTts:sync', 'raw response inspected', {
    keys: respKeys,
    types: respTypes,
    dumpTail: fullDump.slice(0, 2500),
  }, 'D')

  // 兼容多种 data 结构：
  //   (1) data = { audio: "<hex>" }         （Java 示例实测结构）
  //   (2) data = "<hex>"                    （老文档描述）
  //   (3) data = null / undefined / 对象    （用递归最长字符串兜底）
  let audioStr: string | undefined = undefined
  let audioSrcPath = ''

  if (typeof raw.data === 'string') {
    audioStr = raw.data
    audioSrcPath = 'data'
  } else if (raw.data && typeof raw.data === 'object') {
    if (typeof raw.data.audio === 'string') {
      audioStr = raw.data.audio
      audioSrcPath = 'data.audio'
    } else if (typeof raw.data.base64 === 'string') {
      audioStr = raw.data.base64
      audioSrcPath = 'data.base64'
    } else if (typeof raw.data.hex === 'string') {
      audioStr = raw.data.hex
      audioSrcPath = 'data.hex'
    } else if (typeof raw.data.audio_file === 'string') {
      // T2A Pro 返回的是下载链接（我们的接口是同步 v2，应该不会出现）
      audioStr = raw.data.audio_file
      audioSrcPath = 'data.audio_file (WARN: 这是下载链接而非音频数据！)'
    }
  }
  // 兜底：递归找全量字段中最长字符串（音频数据一定是最大的字符串）
  if (!audioStr || audioStr.length < 100) {
    const found = findLongestString(raw)
    if (found.value.length >= 100) {
      audioStr = found.value
      audioSrcPath = `longest@${found.path}`
    }
  }

  if (!audioStr || toPrimitiveString(audioStr).length < 10) {
    agentLog('minimaxTts:sync', 'response dump', {
      keys: respKeys,
      types: respTypes,
      fullDump,
    }, 'E')
    throw new Error(
      `MiniMax 同步合成未返回音频数据。` +
      `\n返回字段：${respKeys.join(', ')}` +
      `\n完整响应 dump：\n${fullDump.slice(0, 2000)}`
    )
  }

  agentLog('minimaxTts:sync', `audio source=${audioSrcPath} len=${audioStr.length}`)
  const buf = decodeAudioData(audioStr)
  const blob = new Blob([buf], { type: 'audio/mpeg' })

  onProgress({ stage: 'done', progress: 1, message: '合成完成' })
  agentLog(
    'minimaxTts:sync',
    'success',
    { chars: text.length, bytes: buf.byteLength, audioLen: resp.extra_info?.audio_length },
    'C',
  )
  return blob
}
