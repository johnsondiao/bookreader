/** 听书音色目录：仅打包中文相关音色（月读/CSS10 为多语模型，可顺带读英文） */

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

/** 精简音色：只保留中文相关，去掉专用英文包以减小 APK */
export const VOICE_CATALOG: VoiceDef[] = [
  {
    key: 'pp-tsukuyomi',
    name: '月读 · 女声（中文）',
    lang: 'both',
    gender: 'female',
    engine: 'piper-plus',
    bundled: true,
    modelUrls: bundledPlus('tsukuyomi', 'tsukuyomi-chan-6lang-fp16.onnx'),
  },
  {
    key: 'pp-css10',
    name: 'CSS10 · 女声（中文）',
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
]

export const DEFAULT_VOICE_ZH = 'pp-tsukuyomi'
export const DEFAULT_VOICE_EN = 'pp-tsukuyomi'
export const DEFAULT_VOICE_NOTE = 'pp-css10'

const REMOVED_EN_VOICE_KEYS = new Set([
  'en-lessac',
  'en-amy',
  'en-hfc-f',
  'en-hfc-m',
  'en-ryan',
  'en-alba',
  'en-alan',
])

/** 已下架的英文专用音色 → 回落到默认中文多语音色 */
export function migrateVoiceKey(key: string | undefined | null): string | undefined {
  if (!key) return undefined
  if (REMOVED_EN_VOICE_KEYS.has(key)) return DEFAULT_VOICE_EN
  return key
}

export function getVoice(key: string | undefined | null): VoiceDef | undefined {
  if (!key) return undefined
  return VOICE_CATALOG.find((v) => v.key === key)
}

export function voicesForLang(lang: 'zh' | 'en'): VoiceDef[] {
  return VOICE_CATALOG.filter((v) => v.lang === lang || v.lang === 'both')
}

export function pickVoice(lang: 'zh' | 'en', preferredKey?: string): VoiceDef {
  const preferred = migrateVoiceKey(preferredKey)
  const hit = getVoice(preferred)
  if (hit && (hit.lang === lang || hit.lang === 'both')) return hit
  const list = voicesForLang(lang)
  if (lang === 'zh') {
    return list.find((v) => v.key === DEFAULT_VOICE_ZH) || list.find((v) => v.bundled) || list[0]
  }
  return list.find((v) => v.key === DEFAULT_VOICE_EN) || list.find((v) => v.bundled) || list[0]
}
