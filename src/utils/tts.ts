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

/**
 * 按句末标点分割文本。piper 对短句的合成质量和速度都远优于整段：
 * - ONNX 推理时间随音素数量近似线性增长，整段 200 字推理要数秒
 * - 长文本的注意力衰减导致韵律变差、声调漂移
 *
 * 分割策略：先按 。！？；\n 切句，超过 50 字的再按 ，, 追加切分。
 */
function splitIntoSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[。！？；\n])/g)
    .map((s) => s.trim())
    .filter(Boolean)

  const result: string[] = []
  for (const s of parts) {
    if (s.length <= 50) {
      result.push(s)
    } else {
      const sub = s
        .split(/(?<=[，,])/g)
        .map((t) => t.trim())
        .filter(Boolean)
      // 合并过短的逗号分句，避免单句太短造成韵律断裂
      let buf = ''
      for (const t of sub) {
        if (buf && buf.length + t.length > 50) {
          result.push(buf)
          buf = t
        } else {
          buf += t
        }
      }
      if (buf) result.push(buf)
    }
  }
  return result
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

type PiperSession = {
  voiceId: string
  predict: (text: string) => Promise<Blob>
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

    m = raw.match(/hf-mirror\.com\/diffusionstudio\/piper-voices\/resolve\/main\/(.+?)(?:\?|$)/)
    if (m) return toRelativeAsset(`tts-models/piper-voices/${m[1]}`)

    return null
  }

  const safeRewrite = (raw: string): string => {
    try {
      const local = rewrite(raw)
      if (local && local !== raw) {
        // #region agent log
        agentLog(
          'tts.ts:rewrite',
          'rewrite to bundled asset',
          { from: raw.slice(0, 140), url: local.slice(0, 140) },
          'C',
        )
        // #endregion
        return local
      }
    } catch {
      /* fall through */
    }
    return raw
  }

  // 拦截 fetch（ORT 动态 import / piper-tts-web 的 fetch 路径）
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = ''
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      url = raw
      if (raw.includes('127.0.0.1:7614') || raw.includes('/ingest/')) {
        return nativeFetch(input, init)
      }
      const local = safeRewrite(raw)
      if (local !== raw) {
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

  // 拦截 XMLHttpRequest：piper-o91UDS6e.js 是 Emscripten 产物，
  // 默认用 XHR 加载 .wasm / .data（见 Emscripten 的 getBinary / fetchRemotePackage），
  // 之前只拦了 fetch，XHR 绕过改写 → CDN 404 或相对路径在 WebView 下解析失败。
  const OrigXHR = window.XMLHttpRequest
  const PatchedXHR = function XMLHttpRequestPatched() {
    const xhr: any = new OrigXHR()
    let _url: string | null = null
    const origOpen: (...args: any[]) => void = xhr.open.bind(xhr)
    xhr.open = function (this: any, ...args: any[]) {
      const raw = typeof args[1] === 'string' ? args[1] : args[1] instanceof URL ? args[1].href : String(args[1] ?? '')
      _url = raw
      const local = safeRewrite(raw)
      const finalUrl = local !== raw ? local : raw
      // #region agent log
      agentLog(
        'tts.ts:xhr',
        'open',
        { method: args[0], from: raw.slice(0, 140), to: finalUrl.slice(0, 140) },
        'D',
      )
      // #endregion
      args[1] = finalUrl
      return origOpen.apply(this, args)
    }
    const origSend: (...args: any[]) => void = xhr.send.bind(xhr)
    xhr.send = function (this: any, ...args: any[]) {
      // #region agent log
      agentLog('tts.ts:xhr', 'send', { url: (_url ?? '').slice(0, 140) }, 'D')
      // #endregion
      return origSend.apply(this, args)
    }
    return xhr
  } as unknown as typeof XMLHttpRequest
  PatchedXHR.prototype = OrigXHR.prototype
  window.XMLHttpRequest = PatchedXHR
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
        `${voice.name} 本地加载失败（不是联网下载）: ${errMsg}\nvoiceId=${voice.voiceId}`,
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
    await loadPiper(voice, onProgress, epoch)
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
          objectUrl: objectUrl.slice(0, 80),
        },
        'A',
      )
      // #endregion

      audio.oncanplay = () => {
        // #region agent log
        agentLog('tts.ts:playBlob', 'oncanplay', { readyState: audio?.readyState }, 'D')
        // #endregion
      }
      audio.onended = () => {
        // #region agent log
        agentLog('tts.ts:playBlob', 'onended', {}, 'A')
        // #endregion
        cleanupAudio()
        finishPlayWait()
        onEnd?.()
      }
      audio.onerror = () => {
        const errMsg = audio?.error?.message ?? '未知错误'
        // #region agent log
        agentLog('tts.ts:playBlob', 'onerror', { message: errMsg }, 'C')
        // #endregion
        cleanupAudio()
        finishPlayWait(new Error(`音频播放失败: ${errMsg}`))
      }
      void audio.play().then(
        () => {
          // #region agent log
          agentLog('tts.ts:playBlob', 'play() resolved', {}, 'D')
          // #endregion
        },
        (e) => {
          // #region agent log
          agentLog(
            'tts.ts:playBlob',
            'play() rejected',
            { err: e instanceof Error ? e.message : String(e) },
            'C',
          )
          // #endregion
          cleanupAudio()
          finishPlayWait(e instanceof Error ? e : new Error(String(e)))
        },
      )
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

    const sentences = splitIntoSentences(trimmed)
    if (sentences.length === 0) return

    // #region agent log
    agentLog(
      'tts.ts:speakWithVoice',
      'start',
      { key: voice.key, engine: voice.engine, lang, rate, textLen: trimmed.length, sentences: sentences.length, preview: trimmed.slice(0, 24) },
      'A',
    )
    // #endregion

    const session = piperCache.get(voice.key)
    if (!session) throw new Error('音色引擎未就绪')

    const playRate = pitch > 1.05 ? rate * 1.08 : pitch < 0.95 ? rate * 0.92 : rate

    // 双缓冲：先合成第一句，播放第一句的同时在后台合成下一句
    let nextBlobPromise: Promise<Blob> | null = null
    try {
      nextBlobPromise = session.predict(sentences[0])
    } catch (err) {
      agentLog('tts.ts:speakWithVoice', 'synthesize failed', { key: voice.key, err: err instanceof Error ? err.message : String(err) }, 'C')
      throw err
    }

    for (let i = 0; i < sentences.length; i++) {
      assertAlive(epoch)

      // 等待当前句合成完成
      let blob: Blob
      try {
        blob = await nextBlobPromise!
      } catch (err) {
        agentLog('tts.ts:speakWithVoice', 'synthesize failed', { key: voice.key, sentence: i, err: err instanceof Error ? err.message : String(err) }, 'C')
        throw err
      }

      // 如果还有下一句，立即开始后台合成（与当前句播放并行）
      if (i + 1 < sentences.length) {
        nextBlobPromise = session.predict(sentences[i + 1])
      } else {
        nextBlobPromise = null
      }

      assertAlive(epoch)

      const silence = await probeWavSilence(blob)
      // #region agent log
      agentLog(
        'tts.ts:speakWithVoice',
        'synth done',
        { key: voice.key, sentence: i, sentences: sentences.length, bytes: blob.size, peak: silence.peak, likelySilent: silence.likelySilent },
        'A',
      )
      // #endregion

      if (silence.likelySilent) {
        throw new Error(`合成结果为静音（peak=${silence.peak}，句 ${i + 1}/${sentences.length}）。`)
      }

      assertAlive(epoch)
      await playBlob(blob, playRate, epoch)
    }
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
