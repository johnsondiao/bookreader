// 本地测试 MiniMax T2A v2 同步语音合成（10 字探测）。
// 运行：node scripts/test-tts-sync.mjs
// 作用：1) 用密码 12345 解密硬编码密文拿到 API key
//       2) 调 api.minimaxi.com/v1/t2a_v2 合成 10 个字
//       3) 打印响应字段结构 + 编码检测 + 音频大小
import * as crypto from 'node:crypto'
import { writeFileSync } from 'node:fs'

const CIPHER = 'CmM9lrxOxJ7Gh7oeHrqJV9mlkMmQ2VPGw+3z+fka+6XhDuiezzLdpuPkC0V954IDWj8HiSMCZx6Nq6F1gkw4P9rVaeyoOxddyVEoXZ3JCy+tw8AW8sV7eMQ+FoE5HUvbITtKEvbW00T1jOmMTrQnbpCqkHBQSn2sHtyHP7rc7EE9JBIgZ0q8U/7Us2OTCA=='
const IV = '/TpFD5hyK/f9c669'
const SALT = 'YlMc0StXxCT0TD8lVofhaQ=='
const PASSWORD = '12345'
const PBKDF2_ITER = 100_000

function b64ToBuf(b64) {
  return Buffer.from(b64, 'base64')
}

async function decrypt() {
  const salt = b64ToBuf(SALT)
  const iv = b64ToBuf(IV)
  const cipher = b64ToBuf(CIPHER)
  const derived = crypto.pbkdf2Sync(PASSWORD, salt, PBKDF2_ITER, 32, 'sha256')
  const decipher = crypto.createDecipheriv('aes-256-gcm', derived, iv)
  // AES-GCM 密文最后 16 字节是 auth tag
  const tag = cipher.subarray(cipher.length - 16)
  const data = cipher.subarray(0, cipher.length - 16)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(data), decipher.final()])
  return plain.toString('utf8')
}

function detectEncoding(s) {
  if (typeof s !== 'string') return { enc: 'base64', note: `typeof=${typeof s}` }
  if (/[+=/\-_]|[G-Z]/.test(s)) return { enc: 'base64', note: 'contains +/= or G-Z' }
  const clean = s.replace(/\s+/g, '')
  if (/^[0-9a-fA]+$/.test(clean) && clean.length % 2 === 0) return { enc: 'hex', note: 'pure hex even length' }
  return { enc: 'base64', note: 'default fallback' }
}

function hexToBuf(hex) {
  const clean = hex.replace(/\s+/g, '')
  return Buffer.from(clean, 'hex')
}
function b64AnyToBuf(b64) {
  let s = String(b64).trim()
  const m = s.match(/^data:[^;]+;base64,(.+)$/i)
  if (m) s = m[1]
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  s = s.replace(/\s+/g, '')
  const padLen = s.length % 4
  if (padLen > 0) s += '='.repeat(4 - padLen)
  return Buffer.from(s, 'base64')
}

/** 在对象里递归找最长字符串，返回 { value, path, depth } */
function findLongestString(obj, depth = 0, maxDepth = 4, path = '') {
  let best = { value: '', path: '' }
  if (!obj || depth >= maxDepth) return best
  if (typeof obj === 'string') return { value: obj, path }
  if (typeof obj !== 'object') return best
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    const subPath = path ? `${path}.${k}` : k
    if (typeof v === 'string' && v.length > best.value.length) {
      best = { value: v, path: subPath }
    } else if (v && typeof v === 'object') {
      const sub = findLongestString(v, depth + 1, maxDepth, subPath)
      if (sub.value.length > best.value.length) best = sub
    }
  }
  return best
}

function truncate(s, n = 120) {
  if (typeof s !== 'string') return String(s).slice(0, n)
  return s.length <= n ? s : s.slice(0, n) + `...(len=${s.length})`
}

/** 递归过一遍响应，所有超过 200 的字符串都截断并标注长度，便于打印结构 */
function sanitizeForPrint(obj, depth = 0, maxDepth = 5) {
  if (!obj || depth >= maxDepth) return obj
  if (typeof obj === 'string') {
    if (obj.length > 200) return `[string len=${obj.length}] ${obj.slice(0, 80)}...`
    return obj
  }
  if (Array.isArray(obj)) return obj.map((x) => sanitizeForPrint(x, depth + 1, maxDepth))
  if (typeof obj === 'object') {
    const out = {}
    for (const k of Object.keys(obj)) out[k] = sanitizeForPrint(obj[k], depth + 1, maxDepth)
    return out
  }
  return obj
}

async function main() {
  console.log('== Step 1: 解密 MiniMax API key ==')
  let apiKey
  try {
    apiKey = await decrypt()
    if (!apiKey) { console.error('解密结果为空'); process.exit(1) }
    console.log(`  解密成功，key 长度 ${apiKey.length}，前缀: ${apiKey.slice(0, 6)}...`)
  } catch (e) {
    console.error('  解密失败：', e.message)
    console.error('  （密码错误 / 密文坏 / IV SALT 不一致）')
    process.exit(1)
  }

  console.log('\n== Step 2: 调用 t2a_v2 同步合成 10 字探测 ==')
  const body = {
    model: 'speech-2.8-turbo',
    text: '今天天气真好适合去散步',
    voice_id: 'audiobook_male_1',
    speed: 1,
    vol: 1,
    pitch: 0,
    audio_sample_rate: 32000,
    bitrate: 128000,
    voice_setting: { voice_id: 'audiobook_male_1', speed: 1, vol: 1, pitch: 1 },
    audio_setting: { audio_sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    timbre_weights: [{ voice_id: 'audiobook_male_1', weight: 1 }],
    language_boost: 'auto',
  }
  const url = 'https://api.minimaxi.com/v1/t2a_v2'
  console.log(`  POST ${url}`)
  console.log(`  model=${body.model}  text="${body.text}"`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  let resp
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const rawText = await r.text()
    clearTimeout(timeout)
    console.log(`\n  HTTP ${r.status} ${r.statusText}`)
    console.log(`  Content-Type: ${r.headers.get('content-type') ?? 'N/A'}`)
    console.log(`  raw body length: ${rawText.length}`)
    if (!r.ok) {
      console.log('\n== ❌ HTTP 错误响应体 ==')
      console.log(rawText.slice(0, 2000))
      process.exit(2)
    }
    // 尝试 JSON 解析
    try {
      resp = JSON.parse(rawText)
      console.log('  ✅ 响应为 JSON')
    } catch (jsonErr) {
      // 如果 content-type 是 audio/mpeg，那就是二进制 MP3
      console.log(`  ⚠️  JSON 解析失败（${jsonErr.message}）——可能是直接返回二进制 MP3`)
      console.log(`  body 前 120 字节(hex): ${Buffer.from(rawText, 'latin1').slice(0, 120).toString('hex')}`)
      const mp3Buf = Buffer.from(rawText, 'latin1')
      writeFileSync(new URL('./test-probe-direct.mp3', import.meta.url), mp3Buf)
      console.log(`  已保存 ${mp3Buf.length} 字节到 scripts/test-probe-direct.mp3`)
      return
    }
  } catch (e) {
    clearTimeout(timeout)
    console.error('  fetch 失败:', e.constructor.name, e.message)
    process.exit(3)
  }

  console.log('\n== Step 3: 响应 JSON 完整结构（长字符串截断）==')
  console.log(JSON.stringify(sanitizeForPrint(resp), null, 2))

  console.log('\n== Step 4: 提取音频字段 ==')
  const keys = Object.keys(resp)
  console.log(`  顶层字段: ${keys.join(', ')}`)

  // 4.1 优先检查我们预期的几个字段
  let audioStr = null
  let audioSrc = ''
  if (typeof resp.data === 'string') { audioStr = resp.data; audioSrc = 'data (string)' }
  else if (resp.data && typeof resp.data === 'object') {
    for (const k of Object.keys(resp.data)) {
      const v = resp.data[k]
      if (typeof v === 'string' && v.length > 100) {
        console.log(`  data.${k}: typeof=string len=${v.length}  head=${truncate(v, 50)}`)
      }
    }
    if (typeof resp.data.audio === 'string') { audioStr = resp.data.audio; audioSrc = 'data.audio' }
    else if (typeof resp.data.base64 === 'string') { audioStr = resp.data.base64; audioSrc = 'data.base64' }
    else if (typeof resp.data.hex === 'string') { audioStr = resp.data.hex; audioSrc = 'data.hex' }
  } else {
    console.log(`  typeof resp.data = ${typeof resp.data}`)
  }

  // 4.2 兜底：递归找最长字符串
  const found = findLongestString(resp)
  console.log(`  最长字符串: path=${found.path || '(无)'}  len=${found.value.length}`)
  if (found.value && (!audioStr || found.value.length > audioStr.length)) {
    audioStr = found.value
    audioSrc = `longest@${found.path}`
  }

  if (!audioStr || audioStr.length < 10) {
    console.error('\n❌ 没找到音频字段')
    process.exit(4)
  }
  console.log(`  ✅ 最终采用: ${audioSrc}, len=${audioStr.length}`)
  console.log(`  前 80 字符: ${truncate(audioStr, 80)}`)

  // 4.3 base_resp 检查
  if (resp.base_resp) {
    console.log(`\n  base_resp: status_code=${resp.base_resp.status_code}  status_msg=${resp.base_resp.status_msg}`)
  }
  if (resp.extra_info) {
    console.log(`  extra_info: ${JSON.stringify(sanitizeForPrint(resp.extra_info))}`)
  }

  console.log('\n== Step 5: 编码检测和解码 ==')
  const det = detectEncoding(audioStr)
  console.log(`  编码检测: ${det.enc} (${det.note})`)

  let mp3Buf
  try {
    mp3Buf = det.enc === 'hex' ? hexToBuf(audioStr) : b64AnyToBuf(audioStr)
    if (mp3Buf.length === 0) throw new Error('0 bytes')
  } catch (e1) {
    console.warn(`  主解码(${det.enc})失败: ${e1.message}，回退`)
    try {
      mp3Buf = det.enc === 'hex' ? b64AnyToBuf(audioStr) : hexToBuf(audioStr)
      if (mp3Buf.length === 0) throw new Error('0 bytes')
      console.log(`  ✅ 回退成功，实际用 ${det.enc === 'hex' ? 'base64' : 'hex'}`)
    } catch (e2) {
      console.error(`  ❌ 两种编码都失败: hex(${e1.message}) / b64(${e2.message})`)
      process.exit(5)
    }
  }

  console.log(`  ✅ 解码后 MP3 字节数: ${mp3Buf.length}`)
  const magic = mp3Buf.slice(0, 3).toString('hex')
  console.log(`  文件头 magic(hex): ${magic} （mp3 正常是 ID3 或 fffb / fff3 / fff2 等帧同步）`)

  const outPath = new URL('./test-probe-output.mp3', import.meta.url)
  writeFileSync(outPath, mp3Buf)
  console.log(`\n== ✅ 成功 ==`)
  console.log(`  已保存到: scripts/test-probe-output.mp3 (${mp3Buf.length} 字节)`)
}

main().catch((e) => {
  console.error('\n未捕获错误：', e)
  process.exit(99)
})
