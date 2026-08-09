/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TTS_KEY_CIPHER: string
  readonly VITE_TTS_KEY_IV: string
  readonly VITE_TTS_KEY_SALT: string
  readonly VITE_DEBUG_ENDPOINT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}