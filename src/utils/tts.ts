import { Capacitor } from '@capacitor/core'
import { TextToSpeech } from '@capacitor-community/text-to-speech'
import { agentLog } from './agentLog'

export type TtsStatus = 'idle' | 'speaking' | 'paused'

export interface TtsController {
  speak: (text: string, rate?: number, opts?: { pitch?: number; voiceIndex?: number }) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  getStatus: () => TtsStatus
  getEngine: () => 'native' | 'web' | 'none'
  /** 探测设备语言/音色（调试与初始化用） */
  probe: () => Promise<Record<string, unknown>>
}

function hasWebSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && !!window.speechSynthesis
}

const LANG_CANDIDATES = ['zh-CN', 'zh_CN', 'zh-Hans', 'zh', 'cmn-CN', 'chi', 'zh-TW', 'zh_TW']

export function createTtsController(onEnd?: () => void, onBoundary?: (charIndex: number) => void): TtsController {
  let status: TtsStatus = 'idle'
  let utterance: SpeechSynthesisUtterance | null = null
  let pausedText: string | null = null
  let pausedRate = 1
  let engine: 'native' | 'web' | 'none' = Capacitor.isNativePlatform()
    ? 'native'
    : hasWebSpeech()
      ? 'web'
      : 'none'
  let cachedLang: string | null = null
  let probed = false

  const pickVoice = () => {
    if (!hasWebSpeech()) return null
    const voices = window.speechSynthesis.getVoices()
    return (
      voices.find((v) => v.lang.startsWith('zh') && /female|xiaoxiao|tingting|huihui|yaoyao/i.test(v.name)) ||
      voices.find((v) => v.lang.startsWith('zh-CN')) ||
      voices.find((v) => v.lang.startsWith('zh')) ||
      null
    )
  }

  const probeNative = async () => {
    const result: Record<string, unknown> = {
      platform: Capacitor.getPlatform(),
      native: Capacitor.isNativePlatform(),
    }
    try {
      const langs = await TextToSpeech.getSupportedLanguages()
      result.languages = langs.languages
      const checks: Record<string, boolean> = {}
      for (const lang of LANG_CANDIDATES) {
        try {
          const r = await TextToSpeech.isLanguageSupported({ lang })
          checks[lang] = !!r.supported
        } catch {
          checks[lang] = false
        }
      }
      result.langChecks = checks
      const voices = await TextToSpeech.getSupportedVoices()
      result.voiceCount = voices.voices?.length ?? 0
      result.zhVoices = (voices.voices || [])
        .map((v, i) => ({ i, lang: v.lang, name: v.name, default: v.default }))
        .filter((v) => /zh|cmn|chi|chinese/i.test(`${v.lang} ${v.name}`))
        .slice(0, 20)
    } catch (err) {
      result.probeError = err instanceof Error ? err.message : String(err)
    }
    probed = true
    // #region agent log
    agentLog('tts.ts:probeNative', 'native TTS probe', result, 'A')
    // #endregion
    return result
  }

  const resolveNativeLang = async (): Promise<string> => {
    if (cachedLang) return cachedLang
    const probe = await probeNative()
    const checks = (probe.langChecks || {}) as Record<string, boolean>
    for (const lang of LANG_CANDIDATES) {
      if (checks[lang]) {
        cachedLang = lang
        // #region agent log
        agentLog('tts.ts:resolveNativeLang', 'picked lang from isLanguageSupported', { lang, checks }, 'A')
        // #endregion
        return lang
      }
    }
    const languages = (probe.languages || []) as string[]
    const hit =
      languages.find((l) => /^zh/i.test(l)) ||
      languages.find((l) => /cmn|chi|chinese/i.test(l)) ||
      null
    if (hit) {
      cachedLang = hit
      // #region agent log
      agentLog('tts.ts:resolveNativeLang', 'picked lang from getSupportedLanguages', { hit, languages: languages.slice(0, 30) }, 'A')
      // #endregion
      return hit
    }
    // #region agent log
    agentLog('tts.ts:resolveNativeLang', 'no Chinese lang found, fallback zh-CN', { languages: languages.slice(0, 30), checks }, 'B')
    // #endregion
    cachedLang = 'zh-CN'
    return cachedLang
  }

  const speakWeb = (text: string, rate: number, pitch = 1) =>
    new Promise<void>((resolve, reject) => {
      if (!hasWebSpeech()) {
        reject(new Error('当前浏览器不支持语音朗读'))
        return
      }
      window.speechSynthesis.cancel()
      utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'zh-CN'
      utterance.rate = rate
      utterance.pitch = pitch
      const voice = pickVoice()
      if (voice) utterance.voice = voice

      utterance.onend = () => {
        status = 'idle'
        utterance = null
        onEnd?.()
        resolve()
      }
      utterance.onerror = () => {
        status = 'idle'
        utterance = null
        resolve()
      }
      utterance.onboundary = (e) => {
        if (e.name === 'word' || e.charIndex != null) onBoundary?.(e.charIndex)
      }

      status = 'speaking'
      window.speechSynthesis.speak(utterance)
    })

  const speakNative = async (text: string, rate: number, pitch = 1, voiceIndex?: number) => {
    status = 'speaking'
    const lang = await resolveNativeLang()
    // #region agent log
    agentLog(
      'tts.ts:speakNative',
      'speakNative attempt',
      { lang, rate, pitch, voiceIndex, textLen: text.length, probed, secondCall: probed },
      'C',
    )
    // #endregion
    try {
      await TextToSpeech.speak({
        text,
        lang,
        rate: Math.min(2, Math.max(0.5, rate)),
        pitch,
        volume: 1.0,
        category: 'playback',
        queueStrategy: 1,
        ...(typeof voiceIndex === 'number' ? { voice: voiceIndex } : {}),
      })
      // #region agent log
      agentLog('tts.ts:speakNative', 'speakNative ok', { lang }, 'A')
      // #endregion
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // #region agent log
      agentLog('tts.ts:speakNative', 'speakNative failed', { lang, err: msg }, 'A')
      // #endregion
      // 语言失败时清缓存并尝试其它候选
      if (/language|not supported|lang/i.test(msg)) {
        cachedLang = null
        for (const alt of LANG_CANDIDATES.filter((l) => l !== lang)) {
          try {
            // #region agent log
            agentLog('tts.ts:speakNative', 'retry with alt lang', { alt }, 'D')
            // #endregion
            await TextToSpeech.speak({
              text,
              lang: alt,
              rate: Math.min(2, Math.max(0.5, rate)),
              pitch,
              volume: 1.0,
              category: 'playback',
              queueStrategy: 1,
            })
            cachedLang = alt
            // #region agent log
            agentLog('tts.ts:speakNative', 'alt lang ok', { alt }, 'D')
            // #endregion
            return
          } catch (e2) {
            // #region agent log
            agentLog(
              'tts.ts:speakNative',
              'alt lang failed',
              { alt, err: e2 instanceof Error ? e2.message : String(e2) },
              'D',
            )
            // #endregion
          }
        }
      }
      throw err
    } finally {
      if (status === 'speaking') status = 'idle'
      onEnd?.()
    }
  }

  return {
    getEngine: () => engine,
    probe: async () => {
      if (Capacitor.isNativePlatform()) return probeNative()
      return { engine: 'web', hasWebSpeech: hasWebSpeech() }
    },
    async speak(text, rate = 1, opts) {
      pausedText = null
      const pitch = opts?.pitch ?? 1
      // #region agent log
      agentLog(
        'tts.ts:speak',
        'speak called',
        {
          engine,
          native: Capacitor.isNativePlatform(),
          textLen: text?.length ?? 0,
          rate,
          pitch,
          voiceIndex: opts?.voiceIndex,
        },
        'E',
      )
      // #endregion
      if (Capacitor.isNativePlatform()) {
        engine = 'native'
        await speakNative(text, rate, pitch, opts?.voiceIndex)
        return
      }
      if (hasWebSpeech()) {
        engine = 'web'
        await speakWeb(text, rate, pitch)
        return
      }
      engine = 'none'
      throw new Error('当前环境不支持语音朗读')
    },
    pause() {
      if (status !== 'speaking') return
      if (engine === 'web' && hasWebSpeech()) {
        window.speechSynthesis.pause()
        status = 'paused'
        return
      }
      pausedText = null
      void TextToSpeech.stop().catch(() => {})
      status = 'paused'
    },
    resume() {
      if (status !== 'paused') return
      if (engine === 'web' && hasWebSpeech()) {
        window.speechSynthesis.resume()
        status = 'speaking'
        return
      }
      status = 'speaking'
      if (pausedText) {
        const t = pausedText
        const r = pausedRate
        pausedText = null
        void this.speak(t, r)
      }
    },
    stop() {
      try {
        if (engine === 'native' || Capacitor.isNativePlatform()) {
          void TextToSpeech.stop().catch(() => {})
        }
        if (hasWebSpeech()) {
          window.speechSynthesis.cancel()
        }
      } catch {
        /* ignore */
      }
      status = 'idle'
      utterance = null
      pausedText = null
    },
    getStatus: () => status,
  }
}
