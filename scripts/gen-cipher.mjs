/**
 * 生成 MiniMax TTS key 的加密密文。
 *
 * 用法：
 *   node scripts/gen-cipher.mjs <password> <plaintext-api-key>
 *
 * 输出三个 base64 字符串，分别填入：
 *   .env.local 的 VITE_TTS_KEY_CIPHER / VITE_TTS_KEY_IV / VITE_TTS_KEY_SALT
 *   以及 GitHub Secrets 同名变量
 */
import { webcrypto as crypto } from 'node:crypto'

const PBKDF2_ITER = 100_000

async function main() {
  const password = process.argv[2]
  const plaintext = process.argv[3]

  if (!password || !plaintext) {
    console.error('用法: node scripts/gen-cipher.mjs <password> <plaintext-api-key>')
    process.exit(1)
  }

  const subtle = crypto.subtle

  // 1. 生成随机 salt (16 bytes) 和 IV (12 bytes for AES-GCM)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  // 2. 用密码 + salt 派生 AES-256 密钥
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  const aesKey = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )

  // 3. 加密明文
  const cipherBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(plaintext),
  )

  // 4. 转 base64
  const toB64 = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))

  const cipherB64 = toB64(cipherBuf)
  const ivB64 = toB64(iv)
  const saltB64 = toB64(salt)

  console.log('=== 填入 .env.local 和 GitHub Secrets ===')
  console.log(`VITE_TTS_KEY_CIPHER=${cipherB64}`)
  console.log(`VITE_TTS_KEY_IV=${ivB64}`)
  console.log(`VITE_TTS_KEY_SALT=${saltB64}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
