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

/** 相对资源 → 绝对 http(s) URL。piper-plus 只认 http(s)，相对路径会误走 HuggingFace */
function toDirectHttpUrl(relOrUrl: string): string {
  if (/^https?:\/\//i.test(relOrUrl)) return relOrUrl
  try {
    return new URL(relOrUrl, window.location.href).href
  } catch {
    const base = import.meta.env.BASE_URL || './'
    return `${base}${relOrUrl.replace(/^\.\//, '').replace(/^\//, '')}`
  }
}

/** 动态 import / wasmPaths 用相对路径，避免 Android WebView 对 https://localhost/*.mjs 失败 */
function toRelativeAsset(rel: string): string {
  const base = import.meta.env.BASE_URL || './'
  return `${base}${rel.replace(/^\//, '')}`
}

/**
 * ort wasmPaths 必须用绝对 URL。
 *
 * ORT 内部 `dynamicImportDefault()` 走 ES module 动态 `import()`，相对路径会以
 * **当前模块 URL**（即编译后的 `assets/ort.bundle.min-*.js`）为 base 解析，
 * 而不是页面 URL。若传 `'./ort/'`，会被解析成 `https://localhost/assets/ort/...`，
 * 但 ort 的 .mjs/.wasm 实际在 `https://localhost/ort/...`，导致 `Failed to fetch
 * dynamically imported module` 与 `wasm: no available backend found`。
 *
 * 用绝对 URL 后，无论 ORT 内部用哪个 base，都能命中正确路径。
 */
function toAbsoluteAssetUrl(rel: string): string {
  const rel2 = rel.replace(/^\//, '')
  try {
    return new URL(`./${rel2}`, window.location.href).href
  } catch {
    return toRelativeAsset(rel)
  }
}

const PLUS_HF_LOCAL: Record<string, string> = {
  'ayousanz/piper-plus-tsukuyomi-chan': 'tts-models/tsukuyomi',
  'ayousanz/piper-plus-css10-ja-6lang': 'tts-models/css10',
}

/** 把外网模型/WASM 请求改写到 APK 内置资源；调试上报地址不记入错误日志 */
function installBundledAssetFetch() {
  const w = window as unknown as { __TTS_BUNDLE_FETCH__?: boolean }
  if (w.__TTS_BUNDLE_FETCH__) return
  w.__TTS_BUNDLE_FETCH__ = true

  const rewrite = (raw: string): string | null => {
    let m = raw.match(/piper-voices\/resolve\/main\/(.+?)(?:\?|$)/)
    if (m) return toRelativeAsset(`tts-models/piper-voices/${m[1]}`)

    if (/piper_phonemize\.wasm(\?|$)/.test(raw)) {
      return toRelativeAsset('tts-models/piper-wasm/piper_phonemize.wasm')
    }
    if (/piper_phonemize\.data(\?|$)/.test(raw)) {
      return toRelativeAsset('tts-models/piper-wasm/piper_phonemize.data')
    }

    m = raw.match(/ort-wasm-simd-threaded[^/?#]*\.(mjs|wasm)(\?|$)/)
    if (m && (raw.includes('cdnjs') || raw.includes('onnxruntime') || raw.includes('jsdelivr'))) {
      const file = raw.split('/').pop()?.split('?')[0]
      if (file) return toRelativeAsset(`ort/${file}`)
    }

    m = raw.match(
      /(?:huggingface\.co|hf-mirror\.com)\/(ayousanz\/piper-plus-[^/]+)\/resolve\/main\/(.+?)(?:\?|$)/,
    )
    if (m) {
      const localDir = PLUS_HF_LOCAL[m[1]]
      if (localDir) return toRelativeAsset(`${localDir}/${m[2]}`)
    }

    m = raw.match(/hf-mirror\.com\/diffusionstudio\/piper-voices\/resolve\/main\/(.+?)(?:\?|$)/)
    if (m) return toRelativeAsset(`tts-models/piper-voices/${m[1]}`)

    return null
  }

  const fakeHfApi = (repo: string): Response | null => {
    const dir = PLUS_HF_LOCAL[repo]
    if (!dir) return null
    // 目录内实际文件名由 VoiceDef.modelUrls 决定；API 仅作 piper-plus 兜底
    const files =
      repo.includes('tsukuyomi')
        ? ['tsukuyomi-chan-6lang-fp16.onnx', 'tsukuyomi-chan-6lang-fp16.onnx.json', 'config.json']
        : repo.includes('css10')
          ? ['css10-ja-6lang-fp16.onnx', 'css10-ja-6lang-fp16.onnx.json', 'config.json']
          : []
    const siblings = files.map((r) => ({ r }))
    return new Response(JSON.stringify({ siblings }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = ''
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      url = raw
      if (raw.includes('127.0.0.1:7614') || raw.includes('/ingest/')) {
        return nativeFetch(input, init)
      }
      const apiHit = raw.match(/huggingface\.co\/api\/models\/(ayousanz\/piper-plus-[^/?#]+)/)
      if (apiHit) {
        const fake = fakeHfApi(apiHit[1])
        if (fake) return fake
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
  /** stop() 递增；合成/播放前检查，避免停后仍播 */
  let speakEpoch = 0

  const assertAlive = (epoch: number) => {
    if (epoch !== speakEpoch) throw new SpeakAborted()
  }

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

  const loadPlus = async (
    voice: VoiceDef,
    onProgress?: (p: TtsProgress) => void,
    epoch = speakEpoch,
  ) => {
    if (plusCache.get(voice.key)?.isInitialized) {
      assertAlive(epoch)
      return
    }
    if (loading.has(voice.key)) {
      await loading.get(voice.key)
      assertAlive(epoch)
      if (plusCache.get(voice.key)?.isInitialized) return
    }
    const urls = voice.modelUrls || []
    const task = (async () => {
      assertAlive(epoch)
      status = 'loading'
      const [{ PiperPlus }, ort] = await Promise.all([import('piper-plus'), import('onnxruntime-web')])
      assertAlive(epoch)
      ort.env.wasm.numThreads = 1
      // ORT 内部用 import() 加载 .mjs，相对路径以 import.meta.url 为 base，
      // 必须用绝对 URL 才能命中 dist/ort/（详见 toAbsoluteAssetUrl 注释）
      ort.env.wasm.wasmPaths = toAbsoluteAssetUrl('ort/')
      // #region agent log
      agentLog('tts.ts:loadPlus', 'ort wasmPaths', { wasmPaths: ort.env.wasm.wasmPaths }, 'C')
      // #endregion
      let lastErr: unknown
      for (const rawUrl of urls) {
        assertAlive(epoch)
        // 必须是绝对 http(s)，否则 piper-plus 会当 HF repo 去联网
        const modelUrl = toDirectHttpUrl(rawUrl)
        try {
          // #region agent log
          agentLog('tts.ts:loadPlus', 'load local', { key: voice.key, modelUrl, bundled: !!voice.bundled }, 'C')
          // #endregion
          const instance = await (PiperPlus.initialize as (opts: unknown) => Promise<PiperPlusInstance>)({
            model: modelUrl,
            ort,
            onProgress: (p: TtsProgress) => {
              if (epoch !== speakEpoch) return
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
          assertAlive(epoch)
          // #region agent log
          agentLog('tts.ts:loadPlus', 'ready', { key: voice.key, modelUrl }, 'C')
          // #endregion
          if (status === 'loading') status = 'idle'
          return
        } catch (err) {
          if (err instanceof SpeakAborted || (err instanceof Error && err.name === 'SpeakAborted')) {
            throw err
          }
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

  const resetMintplexSingleton = (TtsSession: { _instance?: unknown | null }) => {
    try {
      const old = TtsSession._instance as { close?: () => void; dispose?: () => void } | null
      old?.close?.()
      old?.dispose?.()
    } catch {
      /* ignore */
    }
    TtsSession._instance = null
    piperCache.clear()
  }

  const loadPiper = async (
    voice: VoiceDef,
    onProgress?: (p: TtsProgress) => void,
    epoch = speakEpoch,
  ) => {
    if (!voice.voiceId) throw new Error('音色配置缺少 voiceId')
    if (piperCache.has(voice.key)) {
      assertAlive(epoch)
      return
    }
    if (loading.has(voice.key)) {
      await loading.get(voice.key)
      assertAlive(epoch)
      if (piperCache.has(voice.key)) return
    }
    const task = (async () => {
      assertAlive(epoch)
      status = 'loading'
      installBundledAssetFetch()
      onProgress?.({ stage: 'model', progress: 0.1, message: `加载内置音色 ${voice.name}…` })
      const ort = await import('onnxruntime-web')
      assertAlive(epoch)
      // onnxWasm 必须用绝对 URL：mintplex 会把它写入 ort.env.wasm.wasmPaths，
      // ORT 内部 import() 以 import.meta.url 为 base 解析相对路径（详见 toAbsoluteAssetUrl）
      const ortBase = toAbsoluteAssetUrl('ort/')
      ort.env.wasm.numThreads = 1
      ort.env.wasm.wasmPaths = ortBase
      // #region agent log
      agentLog('tts.ts:loadPiper', 'ort wasmPaths', { ortBase }, 'C')
      // #endregion

      const { TtsSession } = await import('@mintplex-labs/piper-tts-web')
      // mintplex 是进程级单例：cache miss 时只要 _instance 还在就必须清掉
      // （含：换音色、新 controller、上次 create 失败残留）
      if ((TtsSession as { _instance?: unknown | null })._instance) {
        resetMintplexSingleton(TtsSession as { _instance?: unknown | null })
      }

      // #region agent log
      agentLog('tts.ts:loadPiper', 'create session local', { key: voice.key, voiceId: voice.voiceId }, 'C')
      // #endregion
      assertAlive(epoch)
      let session
      try {
        session = await TtsSession.create({
          voiceId: voice.voiceId as never,
          progress: (p) => {
            if (epoch !== speakEpoch) return
            const pct = p.total ? p.loaded / p.total : 0
            onProgress?.({
              stage: 'model',
              progress: Math.min(0.95, pct),
              message: `加载 ${voice.name} ${Math.round(pct * 100)}%`,
            })
          },
          wasmPaths: {
            onnxWasm: ortBase,
            piperData: toRelativeAsset('tts-models/piper-wasm/piper_phonemize.data'),
            piperWasm: toRelativeAsset('tts-models/piper-wasm/piper_phonemize.wasm'),
          },
        })
      } catch (createErr) {
        resetMintplexSingleton(TtsSession as { _instance?: unknown | null })
        throw createErr
      }
      assertAlive(epoch)
      // create() 会把 numThreads 改成 hardwareConcurrency，WebView 上易崩
      ort.env.wasm.numThreads = 1
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
      if (err instanceof SpeakAborted || (err instanceof Error && err.name === 'SpeakAborted')) {
        throw err
      }
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

  const ensureVoice = async (
    voice: VoiceDef,
    onProgress?: (p: TtsProgress) => void,
    epoch = speakEpoch,
  ) => {
    if (voice.engine === 'piper-plus') await loadPlus(voice, onProgress, epoch)
    else await loadPiper(voice, onProgress, epoch)
  }

  const ensureReady = async (onProgress?: (p: TtsProgress) => void, voiceKeys?: string[]) => {
    installBundledAssetFetch()
    const epoch = speakEpoch
    const keys =
      voiceKeys && voiceKeys.length
        ? voiceKeys
        : [prefs.zhKey || DEFAULT_VOICE_ZH, prefs.enKey || DEFAULT_VOICE_EN, prefs.noteKey || DEFAULT_VOICE_NOTE]
    const unique = [...new Set(keys.filter(Boolean))] as string[]
    // classic piper 单例只能留一个：预载按 keys 顺序只保留第一套，其余按需加载
    let classicPreloadKey: string | null = null
    // #region agent log
    agentLog('tts.ts:ensureReady', 'start', { keys: unique }, 'D')
    // #endregion
    for (const key of unique) {
      assertAlive(epoch)
      const voice = getVoice(key) || pickVoice('zh', key)
      if (voice.engine === 'piper') {
        if (classicPreloadKey && classicPreloadKey !== voice.key) continue
        classicPreloadKey = voice.key
      }
      await ensureVoice(voice, onProgress, epoch)
      assertAlive(epoch)
    }
    assertAlive(epoch)
    onProgress?.({ stage: 'ready', progress: 1, message: '内置音色已就绪' })
    // #region agent log
    agentLog('tts.ts:ensureReady', 'all ready', { keys: unique, classicPreloadKey }, 'D')
    // #endregion
  }

  const playBlob = (blob: Blob, playbackRate: number, epoch: number) =>
    new Promise<void>((resolve, reject) => {
      assertAlive(epoch)
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
          epoch,
        },
        'A',
      )
      // #endregion

      audio.onended = () => {
        cleanupAudio()
        finishPlayWait()
        onEnd?.()
      }
      audio.onerror = () => {
        cleanupAudio()
        finishPlayWait(new Error('音频播放失败'))
      }
      void audio.play().catch((e) => {
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
    epoch: number,
  ) => {
    assertAlive(epoch)
    await ensureVoice(voice, undefined, epoch)
    assertAlive(epoch)
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

    assertAlive(epoch)

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

    assertAlive(epoch)
    const playRate = pitch > 1.05 ? rate * 1.08 : pitch < 0.95 ? rate * 0.92 : rate
    await playBlob(blob, playRate, epoch)
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
      const epoch = speakEpoch
      const pitch = opts?.pitch ?? 1
      const hint = opts?.langHint || 'auto'
      const lang = hint === 'auto' ? detectTextLang(text) : hint
      const preferred =
        opts?.voiceKey ||
        (lang === 'zh' ? prefs.zhKey : prefs.enKey) ||
        undefined
      const voice = pickVoice(lang, preferred)
      try {
        await speakWithVoice(text, rate, lang, pitch, voice, epoch)
      } catch (err) {
        if (err instanceof SpeakAborted || (err instanceof Error && err.name === 'SpeakAborted')) {
          return
        }
        throw err
      } finally {
        if (status === 'speaking' && epoch === speakEpoch) status = 'idle'
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
      speakEpoch += 1
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
