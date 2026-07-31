export type TtsStatus = 'idle' | 'speaking' | 'paused'

export interface TtsController {
  speak: (text: string, rate?: number) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  getStatus: () => TtsStatus
}

export function createTtsController(onEnd?: () => void, onBoundary?: (charIndex: number) => void): TtsController {
  let status: TtsStatus = 'idle'
  let utterance: SpeechSynthesisUtterance | null = null

  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices()
    return (
      voices.find((v) => v.lang.startsWith('zh') && /female|xiaoxiao|tingting|huihui|yaoyao/i.test(v.name)) ||
      voices.find((v) => v.lang.startsWith('zh-CN')) ||
      voices.find((v) => v.lang.startsWith('zh')) ||
      null
    )
  }

  return {
    speak(text, rate = 1) {
      return new Promise((resolve, reject) => {
        if (!('speechSynthesis' in window)) {
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
          onEnd?.()
          resolve()
        }
        utterance.onerror = () => {
          status = 'idle'
          resolve()
        }
        utterance.onboundary = (e) => {
          if (e.name === 'word' || e.charIndex != null) {
            onBoundary?.(e.charIndex)
          }
        }

        status = 'speaking'
        window.speechSynthesis.speak(utterance)
      })
    },
    pause() {
      if (status === 'speaking') {
        window.speechSynthesis.pause()
        status = 'paused'
      }
    },
    resume() {
      if (status === 'paused') {
        window.speechSynthesis.resume()
        status = 'speaking'
      }
    },
    stop() {
      window.speechSynthesis.cancel()
      status = 'idle'
      utterance = null
    },
    getStatus: () => status,
  }
}
