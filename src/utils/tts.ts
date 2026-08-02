import { Capacitor } from '@capacitor/core'
import { TextToSpeech, type SpeechSynthesisVoice } from '@capacitor-community/text-to-speech'
import { agentLog } from './agentLog'

export type TtsStatus = 'idle' | 'speaking' | 'paused'

export type TtsVoiceRef = {
  /** getSupportedVoices 下标，运行时解析 */
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
  getEngine: () => 'native' | 'web' | 'none'
  probe: () => Promise<{
    chineseOk: boolean
    englishOk: boolean
    languages: string[]
    voices: TtsVoiceRef[]
    zhVoices: TtsVoiceRef[]
    enVoices: TtsVoiceRef[]
  }>
  /** 打开系统语音数据安装页（请一次勾选中文+英文等） */
  openLanguageInstall: () => Promise<void>
  listVoices: () => Promise<TtsVoiceRef[]>
  setPrefs: (prefs: TtsVoicePrefs) => void
  getPrefs: () => TtsVoicePrefs
}

function hasWebSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && !!window.speechSynthesis
}

const ZH_LANGS = ['zh-CN', 'zh_CN', 'zh-Hans', 'zh', 'cmn-CN', 'chi', 'zh-TW', 'zh_TW', 'zh-HK']
const EN_LANGS = ['en-US', 'en_US', 'en-GB', 'en_GB', 'en-AU', 'en', 'eng']

function voiceKey(lang: string, name: string) {
  return `${lang}||${name}`
}

function isZhLang(lang: string) {
  return /zh|cmn|chi|chinese/i.test(lang)
}

function isEnLang(lang: string) {
  return /^en/i.test(lang) || /english/i.test(lang)
}

function detectTextLang(text: string): 'zh' | 'en' {
  const sample = text.slice(0, 80)
  const latin = (sample.match(/[A-Za-z]/g) || []).length
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk >= latin ? 'zh' : 'en'
}

function toVoiceRef(v: SpeechSynthesisVoice, index: number): TtsVoiceRef {
  return {
    index,
    lang: v.lang || '',
    name: v.name || `voice-${index}`,
    key: voiceKey(v.lang || '', v.name || `voice-${index}`),
  }
}

export function createTtsController(onEnd?: () => void, onBoundary?: (charIndex: number) => void): TtsController {
  let status: TtsStatus = 'idle'
  let utterance: SpeechSynthesisUtterance | null = null
  let engine: 'native' | 'web' | 'none' = Capacitor.isNativePlatform()
    ? 'native'
    : hasWebSpeech()
      ? 'web'
      : 'none'
  let cachedVoices: TtsVoiceRef[] = []
  let prefs: TtsVoicePrefs = {}

  const pickWebVoice = (lang: 'zh' | 'en', preferredKey?: string) => {
    if (!hasWebSpeech()) return null
    const voices = window.speechSynthesis.getVoices()
    if (preferredKey) {
      const [pl, ...rest] = preferredKey.split('||')
      const pn = rest.join('||')
      const hit = voices.find((v) => v.lang === pl && v.name === pn)
      if (hit) return hit
    }
    if (lang === 'zh') {
      return (
        voices.find((v) => v.lang.startsWith('zh') && /female|xiaoxiao|ting|hui|yao/i.test(v.name)) ||
        voices.find((v) => v.lang.startsWith('zh-CN')) ||
        voices.find((v) => v.lang.startsWith('zh')) ||
        null
      )
    }
    return (
      voices.find((v) => v.lang.startsWith('en-US')) ||
      voices.find((v) => v.lang.startsWith('en')) ||
      null
    )
  }

  const refreshVoices = async (): Promise<TtsVoiceRef[]> => {
    if (Capacitor.isNativePlatform()) {
      const { voices } = await TextToSpeech.getSupportedVoices()
      cachedVoices = (voices || []).map((v, i) => toVoiceRef(v, i))
      return cachedVoices
    }
    if (hasWebSpeech()) {
      const voices = window.speechSynthesis.getVoices()
      cachedVoices = voices.map((v, i) =>
        toVoiceRef({ lang: v.lang, name: v.name, default: v.default } as SpeechSynthesisVoice, i),
      )
      return cachedVoices
    }
    cachedVoices = []
    return cachedVoices
  }

  const resolveVoiceIndex = (key: string | undefined, lang: 'zh' | 'en'): number | undefined => {
    if (!cachedVoices.length) return undefined
    if (key) {
      const hit = cachedVoices.find((v) => v.key === key)
      if (hit) return hit.index
    }
    const pool = cachedVoices.filter((v) => (lang === 'zh' ? isZhLang(v.lang) : isEnLang(v.lang)))
    return pool[0]?.index
  }

  const resolveLangCode = (lang: 'zh' | 'en', voiceIdx?: number): string => {
    if (typeof voiceIdx === 'number') {
      const v = cachedVoices.find((x) => x.index === voiceIdx)
      if (v?.lang) return v.lang
    }
    return lang === 'zh' ? 'zh-CN' : 'en-US'
  }

  const probe = async () => {
    // #region agent log
    agentLog('tts.ts:probe', 'probe start', { native: Capacitor.isNativePlatform() }, 'B')
    // #endregion
    let languages: string[] = []
    if (Capacitor.isNativePlatform()) {
      try {
        const r = await TextToSpeech.getSupportedLanguages()
        languages = r.languages || []
      } catch {
        languages = []
      }
    }
    const voices = await refreshVoices()
    const zhVoices = voices.filter((v) => isZhLang(v.lang) || /chinese|中文/i.test(v.name))
    const enVoices = voices.filter((v) => isEnLang(v.lang) || /english|英文/i.test(v.name))
    const chineseOk =
      zhVoices.length > 0 ||
      languages.some((l) => ZH_LANGS.some((z) => l.toLowerCase().startsWith(z.split('-')[0].toLowerCase()) && /zh|cmn|chi/i.test(l)))
    const englishOk = enVoices.length > 0 || languages.some((l) => /^en/i.test(l))

    const result = { chineseOk, englishOk, languages, voices, zhVoices, enVoices }
    // #region agent log
    agentLog(
      'tts.ts:probe',
      'probe done',
      {
        chineseOk,
        englishOk,
        langCount: languages.length,
        voiceCount: voices.length,
        zh: zhVoices.length,
        en: enVoices.length,
      },
      'B',
    )
    // #endregion
    return result
  }

  const openLanguageInstall = async () => {
    if (!Capacitor.isNativePlatform()) {
      throw new Error('请在安卓手机上安装系统语音包')
    }
    // #region agent log
    agentLog('tts.ts:openLanguageInstall', 'openInstall for zh+en voices', {}, 'B')
    // #endregion
    try {
      await TextToSpeech.openInstall()
    } catch (err) {
      // #region agent log
      agentLog(
        'tts.ts:openLanguageInstall',
        'openInstall failed',
        { err: err instanceof Error ? err.message : String(err) },
        'B',
      )
      // #endregion
      throw new Error('无法打开语音包安装页。请到：系统设置 → 语言和输入法 → 文字转语音（TTS）→ 安装语音数据')
    }
  }

  const speakWeb = (text: string, rate: number, pitch: number, lang: 'zh' | 'en', voiceKey?: string) =>
    new Promise<void>((resolve, reject) => {
      if (!hasWebSpeech()) {
        reject(new Error('当前浏览器不支持语音朗读'))
        return
      }
      window.speechSynthesis.cancel()
      utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = lang === 'zh' ? 'zh-CN' : 'en-US'
      utterance.rate = rate
      utterance.pitch = pitch
      const voice = pickWebVoice(lang, voiceKey)
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

  const speakNative = async (text: string, rate: number, pitch: number, lang: 'zh' | 'en', preferredKey?: string) => {
    status = 'speaking'
    if (!cachedVoices.length) await refreshVoices()
    const voiceIndex = resolveVoiceIndex(preferredKey, lang)
    const langCode = resolveLangCode(lang, voiceIndex)

    // #region agent log
    agentLog(
      'tts.ts:speakNative',
      'speakNative',
      { lang, langCode, voiceIndex, preferredKey, textLen: text.length },
      'B',
    )
    // #endregion

    try {
      await TextToSpeech.speak({
        text,
        lang: langCode,
        rate: Math.min(2, Math.max(0.5, rate)),
        pitch,
        volume: 1.0,
        category: 'playback',
        queueStrategy: 1,
        ...(typeof voiceIndex === 'number' ? { voice: voiceIndex } : {}),
      })
      // #region agent log
      agentLog('tts.ts:speakNative', 'ok', { langCode, voiceIndex }, 'B')
      // #endregion
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // #region agent log
      agentLog('tts.ts:speakNative', 'failed', { langCode, err: msg }, 'B')
      // #endregion
      if (/language|not supported|lang/i.test(msg)) {
        // 再试一组常见语言码，不自动弹安装页
        const alts = lang === 'zh' ? ZH_LANGS : EN_LANGS
        for (const alt of alts) {
          if (alt === langCode) continue
          try {
            await TextToSpeech.speak({
              text,
              lang: alt,
              rate: Math.min(2, Math.max(0.5, rate)),
              pitch,
              volume: 1.0,
              category: 'playback',
              queueStrategy: 1,
              ...(typeof voiceIndex === 'number' ? { voice: voiceIndex } : {}),
            })
            return
          } catch {
            /* try next */
          }
        }
        throw new Error(
          lang === 'zh'
            ? '缺少中文语音包。请到设置里点「一次性安装中英语音包」，勾选中文（简体）和英文后返回'
            : '缺少英文语音包。请到设置里点「一次性安装中英语音包」，勾选 English 后返回',
        )
      }
      throw err
    } finally {
      if (status === 'speaking') status = 'idle'
      onEnd?.()
    }
  }

  return {
    getEngine: () => engine,
    setPrefs: (p) => {
      prefs = { ...prefs, ...p }
    },
    getPrefs: () => ({ ...prefs }),
    listVoices: refreshVoices,
    probe,
    openLanguageInstall,
    async speak(text, rate = 1, opts) {
      pausedText = null
      const pitch = opts?.pitch ?? 1
      const hint = opts?.langHint || 'auto'
      const lang = hint === 'auto' ? detectTextLang(text) : hint
      const voiceKey =
        opts?.voiceKey ||
        (lang === 'zh' ? prefs.zhKey : prefs.enKey) ||
        undefined

      // #region agent log
      agentLog('tts.ts:speak', 'speak', { lang, voiceKey, rate, pitch, textLen: text.length }, 'B')
      // #endregion

      if (Capacitor.isNativePlatform()) {
        engine = 'native'
        await speakNative(text, rate, pitch, lang, voiceKey)
        return
      }
      if (hasWebSpeech()) {
        engine = 'web'
        await speakWeb(text, rate, pitch, lang, voiceKey)
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
