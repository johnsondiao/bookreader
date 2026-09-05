/// <reference types="vite/client" />

/** vite define 注入的版本号（package.json version） */
declare const __APP_VERSION__: string
/** vite define 注入的构建号（CI run number，本地为 dev） */
declare const __APP_BUILD__: string

interface ImportMetaEnv {
  readonly VITE_TTS_KEY_CIPHER: string
  readonly VITE_TTS_KEY_IV: string
  readonly VITE_TTS_KEY_SALT: string
  readonly VITE_DEBUG_ENDPOINT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}