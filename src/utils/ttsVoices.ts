/** 听书音色目录：全部模型已打包进 public/tts-models，运行时不访问外网 */

export type VoiceLang = 'zh' | 'en' | 'both'

export type VoiceEngine = 'piper-plus' | 'piper'

export type VoiceDef = {
  key: string
  name: string
  /** 适合的语言；both 表示中英都可用 */
  lang: VoiceLang
  gender: 'female' | 'male' | 'neutral'
  engine: VoiceEngine
  /** piper-plus：本地打包路径 */
  modelUrls?: string[]
  /** classic piper：mintplex voiceId（模型已内置） */
  voiceId?: string
  /** 是否已内置到 APK */
  bundled?: boolean
}

/** Capacitor/Vite 相对路径 */
function bundledPlus(dir: string, file: string) {
  return [`${import.meta.env.BASE_URL}tts-models/${dir}/${file}`]
}

/** 精选音色：全部已内置打包 */
export const VOICE_CATALOG: VoiceDef[] = [
  {
    key: 'pp-tsukuyomi',
    name: '月读 · 女声（中英）',
    lang: 'both',
    gender: 'female',
    engine: 'piper-plus',
    bundled: true,
    modelUrls: bundledPlus('tsukuyomi', 'tsukuyomi-chan-6lang-fp16.onnx'),
  },
  {
    key: 'pp-css10',
    name: 'CSS10 · 女声（中英）',
    lang: 'both',
    gender: 'female',
    engine: 'piper-plus',
    bundled: true,
    modelUrls: bundledPlus('css10', 'css10-ja-6lang-fp16.onnx'),
  },
  {
    key: 'zh-huayan',
    name: '华严 · 女声（中文）',
    lang: 'zh',
    gender: 'female',
    engine: 'piper',
    bundled: true,
    voiceId: 'zh_CN-huayan-medium',
  },
  {
    key: 'zh-huayan-lite',
    name: '华严轻量 · 女声（中文）',
    lang: 'zh',
    gender: 'female',
    engine: 'piper',
    bundled: true,
    voiceId: 'zh_CN-huayan-x_low',
  },
  {
    key: 'en-lessac',
    name: 'Lessac · 女声（英文）',
    lang: 'en',
    gender: 'female',
    engine: 'piper',
    bundled: true,
    voiceId: 'en_US-lessac-medium',
  },
  {
    key: 'en-amy',
    name: 'Amy · 女声（英文）',
    lang: 'en',
    gender: 'female',
    engine: 'piper',
    bundled: true,
    voiceId: 'en_US-amy-medium',
  },
  {
    key: 'en-hfc-f',
    name: 'HFC · 女声（英文）',
    lang: 'en',
    gender: 'female',
    engine: 'piper',
    bundled: true,
    voiceId: 'en_US-hfc_female-medium',
  },
  {
    key: 'en-hfc-m',
    name: 'HFC · 男声（英文）',
    lang: 'en',
    gender: 'male',
    engine: 'piper',
    bundled: true,
    voiceId: 'en_US-hfc_male-medium',
  },
  {
    key: 'en-ryan',
    name: 'Ryan · 男声（英文）',
    lang: 'en',
    gender: 'male',
    engine: 'piper',
    bundled: true,
    voiceId: 'en_US-ryan-medium',
  },
  {
    key: 'en-alba',
    name: 'Alba · 女声（英式）',
    lang: 'en',
    gender: 'female',
    engine: 'piper',
    bundled: true,
    voiceId: 'en_GB-alba-medium',
  },
  {
    key: 'en-alan',
    name: 'Alan · 男声（英式）',
    lang: 'en',
    gender: 'male',
    engine: 'piper',
    bundled: true,
    voiceId: 'en_GB-alan-medium',
  },
]

export const DEFAULT_VOICE_ZH = 'pp-tsukuyomi'
export const DEFAULT_VOICE_EN = 'pp-tsukuyomi'
export const DEFAULT_VOICE_NOTE = 'pp-css10'

export function getVoice(key: string | undefined | null): VoiceDef | undefined {
  if (!key) return undefined
  return VOICE_CATALOG.find((v) => v.key === key)
}

export function voicesForLang(lang: 'zh' | 'en'): VoiceDef[] {
  return VOICE_CATALOG.filter((v) => v.lang === lang || v.lang === 'both')
}

export function pickVoice(lang: 'zh' | 'en', preferredKey?: string): VoiceDef {
  const hit = getVoice(preferredKey)
  if (hit && (hit.lang === lang || hit.lang === 'both')) return hit
  const list = voicesForLang(lang)
  if (lang === 'zh') {
    return list.find((v) => v.key === DEFAULT_VOICE_ZH) || list.find((v) => v.bundled) || list[0]
  }
  return list.find((v) => v.key === DEFAULT_VOICE_EN) || list.find((v) => v.bundled) || list[0]
}
