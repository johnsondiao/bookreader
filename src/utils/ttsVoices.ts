/**
 * 听书音色目录：MiniMax 在线语音合成（speech-2.8-turbo，异步长文本 T2A）。
 *
 * 旧的本地离线引擎（piper 华严 / sherpa-onnx matcha）已全部移除，
 * 现在统一走 MiniMax 云端合成，音色 voice_id 来自 MiniMax 系统音色库。
 */

export type VoiceLang = 'zh' | 'en' | 'both'

export type VoiceDef = {
  /** 应用内稳定 key（持久化在设置里，不要随意改动） */
  key: string
  /** 展示名 */
  name: string
  gender: 'female' | 'male' | 'neutral'
  /** MiniMax voice_id（传给 t2a_async_v2 的 voice_setting.voice_id） */
  voiceId: string
  /** 适合的语言；MiniMax 多语模型均标 both */
  lang: VoiceLang
}

/**
 * 精选 MiniMax 中文系统音色。voice_id 取自
 * https://platform.minimaxi.com/docs/api-reference/voice-management-get
 */
export const VOICE_CATALOG: VoiceDef[] = [
  {
    key: 'minimax-news-female',
    name: '新闻女声 · 沉稳播报（推荐）',
    gender: 'female',
    voiceId: 'Chinese (Mandarin)_News_Anchor',
    lang: 'both',
  },
  {
    key: 'minimax-warm-girl',
    name: '温暖少女 · 亲切',
    gender: 'female',
    voiceId: 'Chinese (Mandarin)_Warm_Girl',
    lang: 'both',
  },
  {
    key: 'minimax-gentleman',
    name: '温润男声 · 讲述',
    gender: 'male',
    voiceId: 'Chinese (Mandarin)_Gentleman',
    lang: 'both',
  },
  {
    key: 'minimax-announcer-male',
    name: '播报男声 · 浑厚',
    gender: 'male',
    voiceId: 'Chinese (Mandarin)_Male_Announcer',
    lang: 'both',
  },
  {
    key: 'minimax-shaonv',
    name: '少女 · 经典',
    gender: 'female',
    voiceId: 'female-shaonv',
    lang: 'both',
  },
  {
    key: 'minimax-jingying',
    name: '精英青年 · 经典',
    gender: 'male',
    voiceId: 'male-qn-jingying',
    lang: 'both',
  },
]

/** 默认音色：新闻女声。旧 key（华严 / sherpa 等）会经 migrateVoiceKey 回落到此。 */
export const DEFAULT_VOICE_ZH = 'minimax-news-female'
export const DEFAULT_VOICE_EN = 'minimax-news-female'
/** 注释段默认音色：精英青年（与正文播报区分） */
export const DEFAULT_VOICE_NOTE = 'minimax-jingying'

/** 已下架的旧音色 key → 回落到默认。含 piper 华严系列、sherpa matcha、早期英文音色。 */
const REMOVED_VOICE_KEYS = new Set([
  'zh-huayan',
  'zh-huayan-lite',
  'sherpa-matcha-zh-en',
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

/** 已下架 / 不在当前目录中的 key → 回落到默认中文音色；否则原样返回 */
export function migrateVoiceKey(key: string | undefined | null): string | undefined {
  if (!key) return undefined
  if (REMOVED_VOICE_KEYS.has(key)) return DEFAULT_VOICE_ZH
  if (!VOICE_CATALOG.some((v) => v.key === key)) return DEFAULT_VOICE_ZH
  return key
}

export function getVoice(key: string | undefined | null): VoiceDef | undefined {
  if (!key) return undefined
  return VOICE_CATALOG.find((v) => v.key === key)
}

export function voicesForLang(_lang: 'zh' | 'en'): VoiceDef[] {
  // MiniMax 多语模型中英都可读，统一返回全部音色
  return VOICE_CATALOG
}

export function pickVoice(_lang: 'zh' | 'en', preferredKey?: string): VoiceDef {
  const preferred = migrateVoiceKey(preferredKey)
  const hit = getVoice(preferred)
  if (hit) return hit
  return VOICE_CATALOG[0]
}
