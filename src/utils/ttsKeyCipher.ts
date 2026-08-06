/**
 * MiniMax key 的加密密文（构建期用密码 12345 + PBKDF2+AES-GCM 加密）。
 *
 * 直接硬编码进 bundle，避免依赖 key.env / GitHub Secret。
 * 运行时由 ttsKeyStore.ts 用用户输入的密码 12345 解密。
 *
 * 如需更换 key：本地运行 `node scripts/gen-cipher.mjs` 重新生成，
 * 把输出的 CIPHER/IV/SALT 覆盖下面三个常量即可。
 */
export const TTS_KEY_CIPHER =
  'CmM9lrxOxJ7Gh7oeHrqJV9mlkMmQ2VPGw+3z+fka+6XhDuiezzLdpuPkC0V954IDWj8HiSMCZx6Nq6F1gkw4P9rVaeyoOxddyVEoXZ3JCy+tw8AW8sV7eMQ+FoE5HUvbITtKEvbW00T1jOmMTrQnbpCqkHBQSn2sHtyHP7rc7EE9JBIgZ0q8U/7Us2OTCA=='
export const TTS_KEY_IV = '/TpFD5hyK/f9c669'
export const TTS_KEY_SALT = 'YlMc0StXxCT0TD8lVofhaQ=='
