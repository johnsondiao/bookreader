import { agentLog } from './agentLog'

export type TtsStatus = 'idle' | 'speaking' | 'paused' | 'loading'

export type TtsVoiceRef = {
  index: number
  lang: string
  name: string
  key: string
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
  /** 预下载并初始化本地模型（首次需联网，之后本地合成） */
  ensureReady: (onProgress?: (p: TtsProgress) => void) => Promise<void>
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

/** 中国大陆可访问的镜像；失败时回退官方 HuggingFace */
const MODEL_URLS = [
  'https://hf-mirror.com/ayousanz/piper-plus-tsukuyomi-chan/resolve/main/tsukuyomi-chan-6lang-fp16.onnx',
  'https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan/resolve/main/tsukuyomi-chan-6lang-fp16.onnx',
]

const BUILTIN_VOICES: TtsVoiceRef[] = [
  { index: 0, lang: 'zh-CN', name: '本地中文', key: 'local||zh' },
  { index: 1, lang: 'en-US', name: '本地英文', key: 'local||en' },
]

function detectTextLang(text: string): 'zh' | 'en' {
  const sample = text.slice(0, 80)
  const latin = (sample.match(/[A-Za-z]/g) || []).length
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk >= latin ? 'zh' : 'en'
}

type PiperInstance = {
  synthesize: (
    text: string,
    opts?: { language?: string; lengthScale?: number; noiseScale?: number },
  ) => Promise<{
    toBlob: () => Blob
    play: () => Promise<void>
    duration: number
  }>
  dispose: () => void
  isInitialized: boolean
}

class SpeakAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'SpeakAborted'
  }
}

export function createTtsController(onEnd?: () => void): TtsController {
  let status: TtsStatus = 'idle'
  let prefs: TtsVoicePrefs = {}
  let piper: PiperInstance | null = null
  let initPromise: Promise<void> | null = null
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null
  let playWait: { resolve: () => void; reject: (e: Error) => void } | null = null

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

  const ensureReady = async (onProgress?: (p: TtsProgress) => void) => {
    if (piper?.isInitialized) {
      onProgress?.({ stage: 'ready', progress: 1, message: '本地引擎已就绪' })
      return
    }
    if (initPromise) {
      await initPromise
      return
    }

    initPromise = (async () => {
      status = 'loading'
      // #region agent log
      agentLog('tts.ts:ensureReady', 'local piper init start', {}, 'L1')
      // #endregion
      try {
        const [{ PiperPlus }, ort] = await Promise.all([
          import('piper-plus'),
          import('onnxruntime-web'),
        ])

        // 交给 Vite 打包后的 wasm 资源路径；Android WebView 强制单线程更稳
        ort.env.wasm.numThreads = 1
        // 若打包器未内联路径，回退到 public/ort（含 simd-threaded 与 jsep）
        if (!ort.env.wasm.wasmPaths) {
          ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`
        }

        let lastErr: unknown
        for (const modelUrl of MODEL_URLS) {
          try {
            // #region agent log
            agentLog('tts.ts:ensureReady', 'trying model url', { modelUrl }, 'L1')
            // #endregion
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const instance = await (PiperPlus.initialize as (opts: any) => Promise<PiperInstance>)({
              model: modelUrl,
              ort,
              onProgress: (p: TtsProgress) => {
                onProgress?.(p)
                // #region agent log
                agentLog(
                  'tts.ts:ensureReady',
                  'progress',
                  { stage: p.stage, progress: p.progress, message: p.message },
                  'L1',
                )
                // #endregion
              },
              wasmLoader: async () => {
                const mod = await import('piper-plus/wasm/multilingual')
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const init = (mod as any).default
                if (typeof init === 'function') await init()
                return mod
              },
            })
            piper = instance
            // #region agent log
            agentLog('tts.ts:ensureReady', 'piper ready', { modelUrl }, 'L1')
            // #endregion
            onProgress?.({ stage: 'ready', progress: 1, message: '本地引擎已就绪' })
            if (status === 'loading') status = 'idle'
            return
          } catch (err) {
            lastErr = err
            // #region agent log
            agentLog(
              'tts.ts:ensureReady',
              'model url failed',
              { modelUrl, err: err instanceof Error ? err.message : String(err) },
              'L1',
            )
            // #endregion
          }
        }
        throw lastErr instanceof Error
          ? lastErr
          : new Error('本地语音模型下载失败，请检查网络后重试')
      } catch (err) {
        initPromise = null
        piper = null
        status = 'idle'
        throw err instanceof Error ? err : new Error(String(err))
      }
    })()

    await initPromise
  }

  const playBlob = (blob: Blob, playbackRate: number) =>
    new Promise<void>((resolve, reject) => {
      cleanupAudio()
      finishPlayWait()
      objectUrl = URL.createObjectURL(blob)
      audio = new Audio(objectUrl)
      audio.playbackRate = Math.min(2, Math.max(0.5, playbackRate))
      status = 'speaking'
      playWait = { resolve, reject }

      audio.onended = () => {
        status = 'idle'
        cleanupAudio()
        onEnd?.()
        finishPlayWait()
      }
      audio.onerror = () => {
        status = 'idle'
        cleanupAudio()
        finishPlayWait(new Error('音频播放失败'))
      }

      void audio.play().catch((e) => {
        status = 'idle'
        cleanupAudio()
        finishPlayWait(e instanceof Error ? e : new Error(String(e)))
      })
    })

  const speakLocal = async (text: string, rate: number, lang: 'zh' | 'en', pitch: number) => {
    await ensureReady()
    if (!piper) throw new Error('本地语音引擎未就绪')

    const trimmed = text.trim()
    if (!trimmed) return

    // piper lengthScale：越小越快；用语速反比近似
    const lengthScale = Math.min(2.2, Math.max(0.55, 1 / rate))
    // #region agent log
    agentLog(
      'tts.ts:speakLocal',
      'synthesize start',
      { lang, rate, lengthScale, pitch, textLen: trimmed.length },
      'L2',
    )
    // #endregion

    const result = await piper.synthesize(trimmed, {
      language: lang,
      lengthScale,
      noiseScale: 0.667,
    })
    const blob = result.toBlob()
    // #region agent log
    agentLog(
      'tts.ts:speakLocal',
      'synthesize done, play wav',
      { bytes: blob.size, duration: result.duration, type: blob.type },
      'L2',
    )
    // #endregion

    // pitch：HTMLAudio 无原生 pitch，注释段用略慢/略快区分（playbackRate 微调）
    const playRate = pitch > 1.05 ? rate * 1.08 : pitch < 0.95 ? rate * 0.92 : rate
    await playBlob(blob, playRate)
  }

  return {
    getEngine: () => (piper?.isInitialized ? 'local' : 'none'),
    setPrefs: (p) => {
      prefs = { ...prefs, ...p }
    },
    getPrefs: () => ({ ...prefs }),
    listVoices: async () => BUILTIN_VOICES,
    ensureReady,
    async probe() {
      const ready = !!piper?.isInitialized
      // #region agent log
      agentLog('tts.ts:probe', 'local probe', { ready }, 'L1')
      // #endregion
      return {
        chineseOk: true,
        englishOk: true,
        languages: ['zh', 'en'],
        voices: BUILTIN_VOICES,
        zhVoices: [BUILTIN_VOICES[0]],
        enVoices: [BUILTIN_VOICES[1]],
        ready,
      }
    },
    async speak(text, rate = 1, opts) {
      const pitch = opts?.pitch ?? 1
      const hint = opts?.langHint || 'auto'
      const lang = hint === 'auto' ? detectTextLang(text) : hint
      // #region agent log
      agentLog('tts.ts:speak', 'speak local', { lang, rate, pitch, textLen: text.length }, 'L2')
      // #endregion
      try {
        await speakLocal(text, rate, lang, pitch)
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
