import fs from 'node:fs'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 从项目根目录的 key.env 读取 MINMAXKEY 明文。
 * key.env 不是 Vite 默认会加载的 .env 文件，且 MINMAXKEY 没有 VITE_ 前缀，
 * 因此这里手动解析。本地开发用；GitHub Actions 也通过 Secret 注入 key.env。
 */
function loadMinimaxKeyPlain(): string {
  try {
    const p = fileURLToPath(new URL('./key.env', import.meta.url))
    const txt = fs.readFileSync(p, 'utf-8')
    const m = txt.match(/^MINMAXKEY\s*=\s*(.+)$/m)
    return (m?.[1] ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * 构建期加密：用固定密码 12345 + PBKDF2 派生 AES-GCM 密钥，
 * 加密 MINMAXKEY 明文，得到密文 / iv / salt（均 base64）。
 *
 * 客户端 bundle 里只有密文，反编译拿不到明文 key。
 * 用户首次运行 App 时输入密码 12345 → 解密 → 明文 key 存 IndexedDB（之后免输入）。
 *
 * 注意：密码 12345 是弱密码，仅作「不让 key 明文进 bundle」的轻量保护。
 * 真要防破解请改用自建代理转发，客户端不持有任何 key。
 */
const ENCRYPT_PASSWORD = '12345'
const PBKDF2_ITER = 100_000
const PBKDF2_KEY_LEN_BITS = 256

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

async function encryptKey(plain: string): Promise<{ cipher: string; iv: string; salt: string } | null> {
  if (!plain) return null
  const subtle = webcrypto.subtle
  const saltBytes = webcrypto.getRandomValues(new Uint8Array(16))
  const ivBytes = webcrypto.getRandomValues(new Uint8Array(12))

  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(ENCRYPT_PASSWORD),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  const aesKey = await subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: PBKDF2_KEY_LEN_BITS },
    false,
    ['encrypt'],
  )
  const cipherBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    aesKey,
    new TextEncoder().encode(plain),
  )
  return {
    cipher: toB64(new Uint8Array(cipherBuf)),
    iv: toB64(ivBytes),
    salt: toB64(saltBytes),
  }
}

const plainKey = loadMinimaxKeyPlain()
// 加密是异步的，先占位，defineConfig 用 await 完成后再导出
let cipherPayload: { cipher: string; iv: string; salt: string } | null = null
const cipherReady = encryptKey(plainKey).then((v) => {
  cipherPayload = v
})

// https://vite.dev/config/
export default defineConfig(async (): Promise<UserConfig> => {
  await cipherReady
  return {
    plugins: [react()],
    // Capacitor WebView 需要相对路径
    base: './',
    assetsInclude: ['**/*.wasm'],
    worker: {
      format: 'es',
    },
    define: {
      // 注入加密后的密文（明文 key 永不进 bundle）
      MINMAXKEY_CIPHER: JSON.stringify(cipherPayload?.cipher ?? ''),
      MINMAXKEY_IV: JSON.stringify(cipherPayload?.iv ?? ''),
      MINMAXKEY_SALT: JSON.stringify(cipherPayload?.salt ?? ''),
    },
  }
})
