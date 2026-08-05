/** 听书音色目录：保留 mintplex 内置的中文音色（华严系列）和 sherpa-onnx matcha 中英音色 */

export type VoiceLang = 'zh' | 'en' | 'both'

/**
 * 引擎类型：
 * - piper / piper-plus（兼容旧 key）
 * - sherpa-onnx-matcha：基于 sherpa-onnx WASM + matcha-icefall-zh-en 模型
 */
export type VoiceEngine = 'piper-plus' | 'piper' | 'sherpa-onnx-matcha'

export type VoiceDef = {
  key: string
  name: string
  /** 适合的语言；both 表示中英都可用（中文模型读英文会有口音，但能读） */
  lang: VoiceLang
  gender: 'female' | 'male' | 'neutral'
  engine: VoiceEngine
  /** classic piper：mintplex voiceId（模型已内置） */
  voiceId?: string
  /** sherpa 引擎：模型文件所在 URL 基础路径（相对站点根目录，必须以 / 结尾） */
  modelBase?: string
  /** sherpa 引擎：说话人 id（matcha-zh-en 默认 0） */
  sid?: number
  /** 是否已内置到 APK */
  bundled?: boolean
}

/**
 * 精简音色：只保留 mintplex 内置中文音色。
 * - 华严 medium：音质较好，体积大
 * - 华严 x_low：体积小、推理快，适合低端机
 * 两者 lang 标 'both'，让英文片段下拉也有可选项（无英文专用模型）。
 */
export const VOICE_CATALOG: VoiceDef[] = [
  {
    key: 'sherpa-matcha-zh-en',
    name: 'Matcha · 中英女声（推荐）',
    lang: 'both',
    gender: 'female',
    engine: 'sherpa-onnx-matcha',
    modelBase: '/sherpa/models/matcha-zh-en/',
    sid: 0,
    bundled: true,
  },
  {
    key: 'zh-huayan',
    name: '华严 · 女声（兜底）',
    lang: 'both',
    gender: 'female',
    engine: 'piper',
    bundled: true,
    voiceId: 'zh_CN-huayan-medium',
  },
  {
    key: 'zh-huayan-lite',
    name: '华严轻量 · 女声（兜底）',
    lang: 'both',
    gender: 'female',
    engine: 'piper',
    bundled: true,
    voiceId: 'zh_CN-huayan-x_low',
  },
]

/** 默认仍走 piper 华严（兜底稳定）；sherpa-matcha-zh-en 作为可选项需先下载资源 */
export const DEFAULT_VOICE_ZH = 'zh-huayan'
export const DEFAULT_VOICE_EN = 'zh-huayan'
export const DEFAULT_VOICE_NOTE = 'zh-huayan'

/**
 * 已下架的音色 key → 回落到默认。包含早期专用英文音色，以及移除的 piper-plus
 * 多语模型（pp-tsukuyomi / pp-css10）：后者依赖外部拼音字典，无法在 WebView
 * 内可靠加载，故整体下架，全部回落到 mintplex 的华严系列。
 */
const REMOVED_VOICE_KEYS = new Set([
  'en-lessac',
  'en-amy',
  'en-hfc-f',
  'en-hfc-m',
  'en-ryan',
  'en-alba',
  'en-alan',
  'pp-tsukuyomi',
  'pp-css10',
])

/** 已下架音色 → 回落到默认中文音色 */
export function migrateVoiceKey(key: string | undefined | null): string | undefined {
  if (!key) return undefined
  if (REMOVED_VOICE_KEYS.has(key)) return DEFAULT_VOICE_ZH
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
