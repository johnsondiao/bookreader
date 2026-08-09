/**
 * MiniMax key 的加密密文（PBKDF2+AES-GCM 加密）。
 *
 * 密文/IV/SALT 通过 VITE_TTS_KEY_* 环境变量注入，不在仓库中明文存储。
 * 运行时由 ttsKeyStore.ts 用用户输入的密码解密。
 *
 * 本地开发：创建 .env.local 文件，填入 VITE_TTS_KEY_CIPHER / VITE_TTS_KEY_IV / VITE_TTS_KEY_SALT
 * CI 构建：通过 GitHub Secrets 注入（VITE_TTS_KEY_CIPHER / VITE_TTS_KEY_IV / VITE_TTS_KEY_SALT）
 * 如需更换 key：本地运行 `node scripts/gen-cipher.mjs` 重新生成。
 */
export const TTS_KEY_CIPHER = import.meta.env.VITE_TTS_KEY_CIPHER || ''
export const TTS_KEY_IV = import.meta.env.VITE_TTS_KEY_IV || ''
export const TTS_KEY_SALT = import.meta.env.VITE_TTS_KEY_SALT || ''
