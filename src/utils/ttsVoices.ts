/** 听书音色目录：按需下载，本地合成 WAV 后播放 */

export type VoiceLang = 'zh' | 'en' | 'both'

export type VoiceEngine = 'piper-plus' | 'piper'

export type VoiceDef = {
  key: string
  name: string
  /** 适合的语言；both 表示中英都可用 */
  lang: VoiceLang
  gender: 'female' | 'male' | 'neutral'
  engine: VoiceEngine
  /** piper-plus：模型直链（镜像优先） */
  modelUrls?: string[]
  /** classic piper：mintplex voiceId */
  voiceId?: string
}

function plusUrls(repo: string, file: string) {
  return [
    `https://hf-mirror.com/${repo}/resolve/main/${file}`,
    `https://huggingface.co/${repo}/resolve/main/${file}`,
  ]
}

/** 精选音色（体积与效果平衡；首次使用会下载对应模型） */
export const VOICE_CATALOG: VoiceDef[] = [
  {
    key: 'pp-tsukuyomi',
    name: '月读 · 女声（中英）',
    lang: 'both',
    gender: 'female',
    engine: 'piper-plus',
    modelUrls: plusUrls(
      'ayousanz/piper-plus-tsukuyomi-chan',
      'tsukuyomi-chan-6lang-fp16.onnx',
    ),
  },
  {
    key: 'pp-css10',
    name: 'CSS10 · 女声（中英）',
    lang: 'both',
    gender: 'female',
    engine: 'piper-plus',
    modelUrls: plusUrls('ayousanz/piper-plus-css10-ja-6lang', 'css10-ja-6lang-fp16.onnx'),
  },
  {
    key: 'zh-huayan',
    name: '华严 · 女声（中文）',
    lang: 'zh',
    gender: 'female',
    engine: 'piper',
    voiceId: 'zh_CN-huayan-medium',
  },
  {
    key: 'zh-huayan-lite',
    name: '华严轻量 · 女声（中文）',
    lang: 'zh',
    gender: 'female',
    engine: 'piper',
    voiceId: 'zh_CN-huayan-x_low',
  },
  {
    key: 'en-lessac',
    name: 'Lessac · 女声（英文）',
    lang: 'en',
    gender: 'female',
    engine: 'piper',
    voiceId: 'en_US-lessac-medium',
  },
  {
    key: 'en-amy',
    name: 'Amy · 女声（英文）',
    lang: 'en',
    gender: 'female',
    engine: 'piper',
    voiceId: 'en_US-amy-medium',
  },
  {
    key: 'en-hfc-f',
    name: 'HFC · 女声（英文）',
    lang: 'en',
    gender: 'female',
    engine: 'piper',
    voiceId: 'en_US-hfc_female-medium',
  },
  {
    key: 'en-hfc-m',
    name: 'HFC · 男声（英文）',
    lang: 'en',
    gender: 'male',
    engine: 'piper',
    voiceId: 'en_US-hfc_male-medium',
  },
  {
    key: 'en-ryan',
    name: 'Ryan · 男声（英文）',
    lang: 'en',
    gender: 'male',
    engine: 'piper',
    voiceId: 'en_US-ryan-medium',
  },
  {
    key: 'en-alba',
    name: 'Alba · 女声（英式）',
    lang: 'en',
    gender: 'female',
    engine: 'piper',
    voiceId: 'en_GB-alba-medium',
  },
  {
    key: 'en-alan',
    name: 'Alan · 男声（英式）',
    lang: 'en',
    gender: 'male',
    engine: 'piper',
    voiceId: 'en_GB-alan-medium',
  },
]

export const DEFAULT_VOICE_ZH = 'pp-tsukuyomi'
export const DEFAULT_VOICE_EN = 'en-lessac'
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
    return list.find((v) => v.key === DEFAULT_VOICE_ZH) || list[0]
  }
  return list.find((v) => v.key === DEFAULT_VOICE_EN) || list[0]
}
