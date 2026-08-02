import { Capacitor } from '@capacitor/core'
import { TextToSpeech } from '@capacitor-community/text-to-speech'
import { agentLog } from './agentLog'

export type TtsStatus = 'idle' | 'speaking' | 'paused'

export interface TtsController {
  speak: (text: string, rate?: number) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  getStatus: () => TtsStatus
  /** web | native */
  getEngine: () => 'native' | 'web' | 'none'
}

function hasWebSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && !!window.speechSynthesis
}

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

  const speakWeb = (text: string, rate: number) =>
    new Promise<void>((resolve, reject) => {
      if (!hasWebSpeech()) {
        reject(new Error('当前浏览器不支持语音朗读'))
        return
      }
      window.speechSynthesis.cancel()
      utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'zh-CN'
      utterance.rate = rate
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

  const speakNative = async (text: string, rate: number) => {
    status = 'speaking'
    try {
      await TextToSpeech.speak({
        text,
        lang: 'zh-CN',
        rate: Math.min(2, Math.max(0.5, rate)),
        pitch: 1.0,
        volume: 1.0,
        category: 'playback',
        queueStrategy: 1,
      })
    } finally {
      if (status === 'speaking') status = 'idle'
      onEnd?.()
    }
  }

  return {
    getEngine: () => engine,
    async speak(text, rate = 1) {
      pausedText = null
      // #region agent log
      agentLog(
        'tts.ts:speak',
        'speak called',
        {
          engine,
          native: Capacitor.isNativePlatform(),
          hasWebSpeech: hasWebSpeech(),
          textLen: text?.length ?? 0,
          rate,
        },
        'E',
      )
      // #endregion

      if (Capacitor.isNativePlatform()) {
        engine = 'native'
        await speakNative(text, rate)
        return
      }
      if (hasWebSpeech()) {
        engine = 'web'
        await speakWeb(text, rate)
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
      // 原生 TTS 无可靠 pause：停住并记下当前段，resume 时重读
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
      // native: Reader 层会重新 speakFrom；此处只恢复状态标记
      status = 'speaking'
      if (pausedText) {
        const t = pausedText
        const r = pausedRate
        pausedText = null
        void this.speak(t, r)
      }
    },
    stop() {
      // #region agent log
      agentLog(
        'tts.ts:stop',
        'stop called',
        { engine, hasWebSpeech: hasWebSpeech(), status },
        'A',
      )
      // #endregion
      try {
        if (engine === 'native' || Capacitor.isNativePlatform()) {
          void TextToSpeech.stop().catch(() => {})
        }
        if (hasWebSpeech()) {
          window.speechSynthesis.cancel()
        }
      } catch (err) {
        // #region agent log
        agentLog(
          'tts.ts:stop',
          'stop threw',
          { err: err instanceof Error ? err.message : String(err) },
          'A',
        )
        // #endregion
      }
      status = 'idle'
      utterance = null
      pausedText = null
    },
    getStatus: () => status,
  }
}
