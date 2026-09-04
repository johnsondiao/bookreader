/**
 * 拉取本地 TTS 的构建依赖（CI 与本地开发共用，幂等）：
 *   1. sherpa-onnx AAR → android/app/libs/（49MB，不进 git）
 *   2. manifest.json 里 bundled=true 的模型文件 → android/app/src/main/assets/tts-models/
 *
 * 已存在且大小一致的文件会跳过，重复执行不会重复下载。
 *
 * 运行：node scripts/fetch-local-tts.mjs
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AAR_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-1.13.7.aar'
const AAR_PATH = join(ROOT, 'android/app/libs/sherpa-onnx-1.13.7.aar')
const MANIFEST = join(ROOT, 'android/app/src/main/assets/tts-models/manifest.json')
const ASSETS = join(ROOT, 'android/app/src/main/assets/tts-models')

async function fetchWithFallback(url) {
  // 清单里的地址默认走 hf-mirror（国内快）；CI 跑在海外节点，镜像不一定可达，
  // 失败时回退 huggingface.co 官方源
  const candidates = [url]
  if (url.startsWith('https://hf-mirror.com')) {
    candidates.push(url.replace('https://hf-mirror.com', 'https://huggingface.co'))
  }
  let lastErr = null
  for (const u of candidates) {
    try {
      const res = await fetch(u, { redirect: 'follow' })
      if (res.ok && res.body) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error(`下载失败：${url}`)
}

async function download(url, dest, expectSize) {
  if (existsSync(dest) && expectSize > 0 && statSync(dest).size === expectSize) {
    console.log(`跳过（已存在）: ${dest}`)
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  console.log(`下载 ${url}`)
  const res = await fetchWithFallback(url)
  if (!res.ok || !res.body) throw new Error(`下载失败 ${url}: ${res.status}`)
  const tmp = dest + '.part'
  const out = createWriteStream(tmp)
  await finished(Readable.fromWeb(res.body).pipe(out))
  renameSync(tmp, dest)
  const got = statSync(dest).size
  if (expectSize > 0 && got !== expectSize) {
    throw new Error(`大小不符 ${dest}: 期望 ${expectSize} 实际 ${got}`)
  }
  console.log(`完成 ${(got / 1048576).toFixed(1)} MB → ${dest}`)
}

// 1) AAR
await download(AAR_URL, AAR_PATH, 49113869)

// 2) 随包模型
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
for (const model of manifest.models) {
  if (!model.bundled) continue
  for (const f of model.files) {
    await download(f.url, join(ASSETS, model.id, f.rel), f.size)
  }
}
console.log('本地 TTS 依赖就绪')
