import { agentLog, nativeFetch } from './agentLog'
import {
  DEFAULT_VOICE_EN,
  DEFAULT_VOICE_NOTE,
  DEFAULT_VOICE_ZH,
  getVoice,
  pickVoice,
  VOICE_CATALOG,
  voicesForLang,
  type VoiceDef,
} from './ttsVoices'

export type TtsStatus = 'idle' | 'speaking' | 'paused' | 'loading'

export type TtsVoiceRef = {
  index: number
  lang: string
  name: string
  key: string
  gender?: string
}

export type TtsVoicePrefs = {
  zhKey?: string
  enKey?: string
  noteKey?: string
}

export type TtsProgress = {
  stage: string
  progress: number
  message: string
}

export interface TtsController {
  speak: (
    text: string,
    rate?: number,
    opts?: { pitch?: number; voiceKey?: string; langHint?: 'zh' | 'en' | 'auto' },
  ) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  getStatus: () => TtsStatus
  getEngine: () => 'local' | 'none'
  /** 预下载并初始化指定/默认音色 */
  ensureReady: (onProgress?: (p: TtsProgress) => void, voiceKeys?: string[]) => Promise<void>
  probe: () => Promise<{
    chineseOk: boolean
    englishOk: boolean
    languages: string[]
    voices: TtsVoiceRef[]
    zhVoices: TtsVoiceRef[]
    enVoices: TtsVoiceRef[]
    ready: boolean
  }>
  listVoices: () => Promise<TtsVoiceRef[]>
  setPrefs: (prefs: TtsVoicePrefs) => void
  getPrefs: () => TtsVoicePrefs
}

export { VOICE_CATALOG, voicesForLang, DEFAULT_VOICE_ZH, DEFAULT_VOICE_EN, DEFAULT_VOICE_NOTE }

class SpeakAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'SpeakAborted'
  }
}

function detectTextLang(text: string): 'zh' | 'en' {
  const sample = text.slice(0, 80)
  const latin = (sample.match(/[A-Za-z]/g) || []).length
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk >= latin ? 'zh' : 'en'
}

function toRef(v: VoiceDef, index: number): TtsVoiceRef {
  return {
    index,
    lang: v.lang === 'both' ? 'zh/en' : v.lang === 'zh' ? 'zh-CN' : 'en',
    name: v.name,
    key: v.key,
    gender: v.gender,
  }
}

type PiperPlusInstance = {
  synthesize: (
    text: string,
    opts?: { language?: string; lengthScale?: number; noiseScale?: number },
  ) => Promise<{
    toBlob: () => Blob
    duration: number
  }>
  dispose: () => void
  isInitialized: boolean
}

type PiperSession = {
  voiceId: string
  predict: (text: string) => Promise<Blob>
}

/** 把外网模型/WASM 请求改写到 APK 内置资源；调试上报地址不记入错误日志 */
function installBundledAssetFetch() {
  const w = window as unknown as { __TTS_BUNDLE_FETCH__?: boolean }
  if (w.__TTS_BUNDLE_FETCH__) return
  w.__TTS_BUNDLE_FETCH__ = true

  const toAsset = (rel: string) => {
    // 相对路径，避免 Android WebView 对 https://localhost 动态 import 失败
    const base = import.meta.env.BASE_URL || './'
    return `${base}${rel.replace(/^\//, '')}`
  }

  const rewrite = (raw: string): string | null => {
    let m = raw.match(/piper-voices\/resolve\/main\/(.+?)(?:\?|$)/)
    if (m) return toAsset(`tts-models/piper-voices/${m[1]}`)

    if (/piper_phonemize\.wasm(\?|$)/.test(raw)) {
      return toAsset('tts-models/piper-wasm/piper_phonemize.wasm')
    }
    if (/piper_phonemize\.data(\?|$)/.test(raw)) {
      return toAsset('tts-models/piper-wasm/piper_phonemize.data')
    }

    m = raw.match(/ort-wasm-simd-threaded[^/?#]*\.(mjs|wasm)(\?|$)/)
    if (m && (raw.includes('cdnjs') || raw.includes('onnxruntime') || raw.includes('jsdelivr'))) {
      const file = raw.split('/').pop()?.split('?')[0]
      if (file) return toAsset(`ort/${file}`)
    }

    m = raw.match(/hf-mirror\.com\/diffusionstudio\/piper-voices\/resolve\/main\/(.+?)(?:\?|$)/)
    if (m) return toAsset(`tts-models/piper-voices/${m[1]}`)

    return null
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = ''
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      url = raw
      if (raw.includes('127.0.0.1:7614') || raw.includes('/ingest/')) {
        return nativeFetch(input, init)
      }
      const local = rewrite(raw)
      if (local) {
        // #region agent log
        agentLog(
          'tts.ts:fetch',
          'rewrite to bundled asset',
          { from: raw.slice(0, 140), url: local.slice(0, 140) },
          'C',
        )
        // #endregion
        input = local
        url = local
      }
    } catch {
      /* fall through */
    }
    try {
      const res = await nativeFetch(input, init)
      if (!res.ok) {
        // #region agent log
        agentLog('tts.ts:fetch', 'fetch not ok', { url: url.slice(0, 180), status: res.status }, 'C')
        // #endregion
      }
      return res
    } catch (err) {
      // #region agent log
      agentLog(
        'tts.ts:fetch',
        'local asset load failed',
        { url: url.slice(0, 180), err: err instanceof Error ? err.message : String(err) },
        'C',
      )
      // #endregion
      throw err
    }
  }
}

/** 采样 WAV 前几帧，判断是否近乎静音 */
async function probeWavSilence(blob: Blob): Promise<{ peak: number; likelySilent: boolean }> {
  try {
    const buf = await blob.arrayBuffer()
    const view = new DataView(buf)
    // 跳过 44 字节 WAV 头（若不足则按全缓冲）
    const start = buf.byteLength > 44 ? 44 : 0
    let peak = 0
    const samples = Math.min(4000, Math.floor((buf.byteLength - start) / 2))
    for (let i = 0; i < samples; i++) {
      const s = Math.abs(view.getInt16(start + i * 2, true))
      if (s > peak) peak = s
    }
    return { peak, likelySilent: peak < 80 }
  } catch {
    return { peak: -1, likelySilent: false }
  }
}

export function createTtsController(onEnd?: () => void): TtsController {
  let status: TtsStatus = 'idle'
  let prefs: TtsVoicePrefs = {
    zhKey: DEFAULT_VOICE_ZH,
    enKey: DEFAULT_VOICE_EN,
    noteKey: DEFAULT_VOICE_NOTE,
  }
  const plusCache = new Map<string, PiperPlusInstance>()
  const piperCache = new Map<string, PiperSession>()
  const loading = new Map<string, Promise<void>>()
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null
  let playWait: { resolve: () => void; reject: (e: Error) => void } | null = null
  let anyReady = false

  const cleanupAudio = () => {
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.src = ''
      audio = null
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  const finishPlayWait = (err?: Error) => {
    const w = playWait
    playWait = null
    if (!w) return
    if (err) w.reject(err)
    else w.resolve()
  }

  const loadPlus = async (voice: VoiceDef, onProgress?: (p: TtsProgress) => void) => {
    if (plusCache.get(voice.key)?.isInitialized) return
    if (loading.has(voice.key)) {
      await loading.get(voice.key)
      return
    }
    const urls = voice.modelUrls || []
    const task = (async () => {
      status = 'loading'
      const [{ PiperPlus }, ort] = await Promise.all([import('piper-plus'), import('onnxruntime-web')])
      // 始终用相对路径，避免 WebView 动态 import https://localhost/ort/*.mjs 失败
      ort.env.wasm.numThreads = 1
      ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL || './'}ort/`
      // #region agent log
      agentLog('tts.ts:loadPlus', 'ort wasmPaths', { wasmPaths: ort.env.wasm.wasmPaths }, 'C')
      // #endregion
      let lastErr: unknown
      for (const rawUrl of urls) {
        // 内置模型保持相对路径，不要转成 https://localhost/...
        const modelUrl = rawUrl
        try {
          // #region agent log
          agentLog('tts.ts:loadPlus', 'load local', { key: voice.key, modelUrl, bundled: !!voice.bundled }, 'C')
          // #endregion
          const instance = await (PiperPlus.initialize as (opts: unknown) => Promise<PiperPlusInstance>)({
            model: modelUrl,
            ort,
            onProgress: (p: TtsProgress) => {
              onProgress?.({ ...p, message: `${voice.name}: ${p.message || p.stage}` })
            },
            wasmLoader: async () => {
              const mod = await import('piper-plus/wasm/multilingual')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const init = (mod as any).default
              if (typeof init === 'function') await init()
              return mod
            },
          })
          plusCache.set(voice.key, instance)
          anyReady = true
          // #region agent log
          agentLog('tts.ts:loadPlus', 'ready', { key: voice.key, modelUrl }, 'C')
          // #endregion
          if (status === 'loading') status = 'idle'
          return
        } catch (err) {
          lastErr = err
          const errMsg = err instanceof Error ? err.message : String(err)
          // #region agent log
          agentLog(
            'tts.ts:loadPlus',
            'failed url',
            { key: voice.key, modelUrl, url: modelUrl, err: errMsg },
            'C',
          )
          // #endregion
          lastErr = new Error(`${voice.name} 本地加载失败: ${errMsg}\nURL=${modelUrl}`)
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`${voice.name} 模型加载失败`)
    })()
    loading.set(voice.key, task)
    try {
      await task
    } finally {
      loading.delete(voice.key)
    }
  }

  const loadPiper = async (voice: VoiceDef, onProgress?: (p: TtsProgress) => void) => {
    if (!voice.voiceId) throw new Error('音色配置缺少 voiceId')
    if (piperCache.has(voice.key)) return
    if (loading.has(voice.key)) {
      await loading.get(voice.key)
      return
    }
    const task = (async () => {
      status = 'loading'
      installBundledAssetFetch()
      onProgress?.({ stage: 'model', progress: 0.1, message: `加载内置音色 ${voice.name}…` })
      // 先配置 ort 走本地相对路径（避免动态 import https://localhost/... 失败）
      const ort = await import('onnxruntime-web')
      const ortBase = `${import.meta.env.BASE_URL || './'}ort/`
      ort.env.wasm.numThreads = 1
      ort.env.wasm.wasmPaths = ortBase
      // #region agent log
      agentLog('tts.ts:loadPiper', 'ort wasmPaths', { ortBase }, 'C')
      // #endregion

      const { TtsSession } = await import('@mintplex-labs/piper-tts-web')
      const rel = (path: string) => `${import.meta.env.BASE_URL || './'}${path}`
      // #region agent log
      agentLog('tts.ts:loadPiper', 'create session local', { key: voice.key, voiceId: voice.voiceId }, 'C')
      // #endregion
      const session = await TtsSession.create({
        voiceId: voice.voiceId as never,
        progress: (p) => {
          const pct = p.total ? p.loaded / p.total : 0
          onProgress?.({
            stage: 'model',
            progress: Math.min(0.95, pct),
            message: `加载 ${voice.name} ${Math.round(pct * 100)}%`,
          })
        },
        wasmPaths: {
          onnxWasm: rel('ort/'),
          piperData: rel('tts-models/piper-wasm/piper_phonemize.data'),
          piperWasm: rel('tts-models/piper-wasm/piper_phonemize.wasm'),
        },
      })
      piperCache.set(voice.key, { voiceId: voice.voiceId!, predict: (t) => session.predict(t) })
      anyReady = true
      // #region agent log
      agentLog('tts.ts:loadPiper', 'ready', { key: voice.key }, 'C')
      // #endregion
      onProgress?.({ stage: 'ready', progress: 1, message: `${voice.name} 已就绪` })
      if (status === 'loading') status = 'idle'
    })()
    loading.set(voice.key, task)
    try {
      await task
    } catch (err) {
      loading.delete(voice.key)
      status = 'idle'
      const errMsg = err instanceof Error ? err.message : String(err)
      // #region agent log
      agentLog(
        'tts.ts:loadPiper',
        'failed',
        { key: voice.key, voiceId: voice.voiceId, err: errMsg },
        'C',
      )
      // #endregion
      throw new Error(
        `${voice.name} 本地加载失败（不是联网下载）: ${errMsg}\nvoiceId=${voice.voiceId}\n可先改用「月读」音色`,
      )
    } finally {
      loading.delete(voice.key)
    }
  }

  const ensureVoice = async (voice: VoiceDef, onProgress?: (p: TtsProgress) => void) => {
    if (voice.engine === 'piper-plus') await loadPlus(voice, onProgress)
    else await loadPiper(voice, onProgress)
  }

  const ensureReady = async (onProgress?: (p: TtsProgress) => void, voiceKeys?: string[]) => {
    installBundledAssetFetch()
    const keys =
      voiceKeys && voiceKeys.length
        ? voiceKeys
        : [prefs.zhKey || DEFAULT_VOICE_ZH, prefs.enKey || DEFAULT_VOICE_EN, prefs.noteKey || DEFAULT_VOICE_NOTE]
    const unique = [...new Set(keys.filter(Boolean))] as string[]
    // #region agent log
    agentLog('tts.ts:ensureReady', 'start', { keys: unique }, 'D')
    // #endregion
    for (const key of unique) {
      const voice = getVoice(key) || pickVoice('zh', key)
      await ensureVoice(voice, onProgress)
    }
    onProgress?.({ stage: 'ready', progress: 1, message: '内置音色已就绪' })
    // #region agent log
    agentLog('tts.ts:ensureReady', 'all ready', { keys: unique }, 'D')
    // #endregion
  }

  const playBlob = (blob: Blob, playbackRate: number) =>
    new Promise<void>((resolve, reject) => {
      cleanupAudio()
      finishPlayWait()
      objectUrl = URL.createObjectURL(blob)
      audio = new Audio(objectUrl)
      audio.volume = 1
      audio.muted = false
      audio.playbackRate = Math.min(2, Math.max(0.5, playbackRate))
      status = 'speaking'
      playWait = { resolve, reject }

      // #region agent log
      agentLog(
        'tts.ts:playBlob',
        'play start',
        {
          bytes: blob.size,
          type: blob.type,
          playbackRate: audio.playbackRate,
          volume: audio.volume,
          muted: audio.muted,
        },
        'B',
      )
      // #endregion

      audio.onended = () => {
        // #region agent log
        agentLog('tts.ts:playBlob', 'play ended', { currentTime: audio?.currentTime ?? -1 }, 'B')
        // #endregion
        status = 'idle'
        cleanupAudio()
        onEnd?.()
        finishPlayWait()
      }
      audio.onerror = () => {
        // #region agent log
        agentLog('tts.ts:playBlob', 'audio element error', {}, 'B')
        // #endregion
        status = 'idle'
        cleanupAudio()
        finishPlayWait(new Error('音频播放失败'))
      }

      void audio.play().then(() => {
        // #region agent log
        agentLog(
          'tts.ts:playBlob',
          'play() resolved',
          {
            paused: audio?.paused ?? true,
            duration: audio?.duration ?? -1,
            volume: audio?.volume ?? -1,
            muted: audio?.muted ?? true,
          },
          'B',
        )
        // #endregion
      }).catch((e) => {
        // #region agent log
        agentLog(
          'tts.ts:playBlob',
          'play() rejected',
          { err: e instanceof Error ? e.message : String(e) },
          'B',
        )
        // #endregion
        status = 'idle'
        cleanupAudio()
        finishPlayWait(e instanceof Error ? e : new Error(String(e)))
      })
    })

  const speakWithVoice = async (
    text: string,
    rate: number,
    lang: 'zh' | 'en',
    pitch: number,
    voice: VoiceDef,
  ) => {
    await ensureVoice(voice)
    const trimmed = text.trim()
    if (!trimmed) return

    const lengthScale = Math.min(2.2, Math.max(0.55, 1 / rate))
    // #region agent log
    agentLog(
      'tts.ts:speakWithVoice',
      'start',
      { key: voice.key, engine: voice.engine, lang, rate, textLen: trimmed.length, preview: trimmed.slice(0, 24) },
      'A',
    )
    // #endregion

    let blob: Blob
    let duration = -1
    try {
      if (voice.engine === 'piper-plus') {
        const piper = plusCache.get(voice.key)
        if (!piper) throw new Error('音色引擎未就绪')
        const result = await piper.synthesize(trimmed, {
          language: lang,
          lengthScale,
          noiseScale: 0.667,
        })
        blob = result.toBlob()
        duration = result.duration
      } else {
        const session = piperCache.get(voice.key)
        if (!session) throw new Error('音色引擎未就绪')
        blob = await session.predict(trimmed)
      }
    } catch (err) {
      // #region agent log
      agentLog(
        'tts.ts:speakWithVoice',
        'synthesize failed',
        {
          key: voice.key,
          engine: voice.engine,
          err: err instanceof Error ? err.message : String(err),
        },
        'C',
      )
      // #endregion
      throw err
    }

    const silence = await probeWavSilence(blob)
    // #region agent log
    agentLog(
      'tts.ts:speakWithVoice',
      'synth done',
      {
        key: voice.key,
        bytes: blob.size,
        type: blob.type,
        duration,
        peak: silence.peak,
        likelySilent: silence.likelySilent,
      },
      'A',
    )
    // #endregion

    const playRate = pitch > 1.05 ? rate * 1.08 : pitch < 0.95 ? rate * 0.92 : rate
    await playBlob(blob, playRate)
  }

  return {
    getEngine: () => (anyReady ? 'local' : 'none'),
    setPrefs: (p) => {
      prefs = { ...prefs, ...p }
    },
    getPrefs: () => ({ ...prefs }),
    listVoices: async () => VOICE_CATALOG.map(toRef),
    ensureReady,
    async probe() {
      const voices = VOICE_CATALOG.map(toRef)
      const zhVoices = voicesForLang('zh').map(toRef)
      const enVoices = voicesForLang('en').map(toRef)
      return {
        chineseOk: true,
        englishOk: true,
        languages: ['zh', 'en'],
        voices,
        zhVoices,
        enVoices,
        ready: anyReady,
      }
    },
    async speak(text, rate = 1, opts) {
      const pitch = opts?.pitch ?? 1
      const hint = opts?.langHint || 'auto'
      const lang = hint === 'auto' ? detectTextLang(text) : hint
      const preferred =
        opts?.voiceKey ||
        (lang === 'zh' ? prefs.zhKey : prefs.enKey) ||
        undefined
      const voice = pickVoice(lang, preferred)
      try {
        await speakWithVoice(text, rate, lang, pitch, voice)
      } catch (err) {
        if (err instanceof SpeakAborted || (err instanceof Error && err.name === 'SpeakAborted')) {
          return
        }
        throw err
      } finally {
        if (status === 'speaking') status = 'idle'
      }
    },
    pause() {
      if (status !== 'speaking' || !audio) return
      audio.pause()
      status = 'paused'
    },
    resume() {
      if (status !== 'paused' || !audio) return
      status = 'speaking'
      void audio.play().catch(() => {})
    },
    stop() {
      status = 'idle'
      cleanupAudio()
      finishPlayWait(new SpeakAborted())
    },
    getStatus: () => status,
  }
}

/** 注释片段：脚注、括号注、以「注」开头等 */
export function splitSpeakSegments(text: string): { text: string; kind: 'body' | 'note' }[] {
  const parts = text.split(/(（注[^）]*）|\(注[^)]*\)|〔[^〕]*〕|【注[^】]*】)/g).filter((p) => p && p.trim())
  if (parts.length <= 1) {
    const t = text.trim()
    if (!t) return []
    if (/^(注[:：]|注释[:：]|——注)/.test(t) || /^\*.+\*$/.test(t)) {
      return [{ text: t, kind: 'note' }]
    }
    return [{ text: t, kind: 'body' }]
  }
  return parts.map((p) => {
    const s = p.trim()
    const note = /^（注/.test(s) || /^\(注/.test(s) || /^〔/.test(s) || /^【注/.test(s)
    return { text: s, kind: note ? ('note' as const) : ('body' as const) }
  })
}
