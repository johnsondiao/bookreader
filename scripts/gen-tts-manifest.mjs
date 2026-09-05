/**
 * 生成本地 TTS 模型下载清单 android/app/src/main/assets/tts-models/manifest.json。
 *
 * 清单同时被三处消费：
 *   1. Android 插件 LocalTtsPlugin：按需下载非随包模型（kokoro 的 espeak-ng-data 有
 *      355 个小文件，不可能在 Kotlin 里写字面量）
 *   2. GitHub Actions：构建前把随包模型（melo）拉进 assets
 *   3. scripts/fetch-local-tts.mjs：本地开发同上
 *
 * 文件列表取自 HuggingFace 官方仓库（hf-mirror 镜像），大小一并写入，
 * 供 UI 显示下载体积、插件校验完整性。
 *
 * 运行：node scripts/gen-tts-manifest.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../android/app/src/main/assets/tts-models/manifest.json')

const HF = 'https://hf-mirror.com/csukuangfj'
const HF_API = 'https://hf-mirror.com/api/models/csukuangfj'
const VOCODER = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models'

/** 通用垃圾文件，任何模型都不下 */
const DROP = [/^\.gitattributes$/, /^LICENSE$/, /^README\.md$/i, /\.py$/, /^dict\/README\.md$/]

/** 每个模型的取文件规则。全部随包（用户明确要求不打在线下载）；
 * melo-tts 已移除：中文韵律偏怪（"像韩国人说中文"），默认改为 kokoro。 */
const SPECS = [
  {
    id: 'matcha-icefall-zh-baker',
    repo: 'matcha-icefall-zh-baker',
    bundled: true,
    pick: () => true,
    extra: [{ rel: 'vocos-22khz-univ.onnx', url: `${VOCODER}/vocos-22khz-univ.onnx` }],
  },
  {
    id: 'kokoro-int8-multi-lang-v1_1',
    repo: 'kokoro-int8-multi-lang-v1_1',
    bundled: true,
    // 配置只用 us-en + zh 两个 lexicon
    pick: (f) => f !== 'lexicon-gb-en.txt',
    extra: [],
  },
]

async function listRepo(repo) {
  // 注意：镜像的仓库列表接口在 /api/models/ 下，直接访问仓库页会返回 HTML
  const url = `${HF_API}/${repo}?blobs=true`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HF 列表失败 ${repo}: ${res.status}`)
  const json = await res.json()
  return json.siblings ?? []
}

const models = []
for (const spec of SPECS) {
  const siblings = await listRepo(spec.repo)
  const files = []
  for (const s of siblings) {
    const rel = s.rfilename
    if (DROP.some((re) => re.test(rel))) continue
    if (!spec.pick(rel)) continue
    if (typeof s.size !== 'number' || s.size <= 0) continue
    files.push({ rel, url: `${HF}/${spec.repo}/resolve/main/${rel}`, size: s.size })
  }
  for (const e of spec.extra) {
    // GitHub release 资产：HEAD 一次拿大小
    const head = await fetch(e.url, { method: 'HEAD' })
    const size = Number(head.headers.get('content-length') ?? 0)
    if (!size) throw new Error(`拿不到大小：${e.url}`)
    files.push({ rel: e.rel, url: e.url, size })
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  const total = files.reduce((s, f) => s + f.size, 0)
  models.push({ id: spec.id, bundled: spec.bundled, files, totalBytes: total })
  console.log(`${spec.id}: ${files.length} 个文件, ${(total / 1048576).toFixed(1)} MB`)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), models }, null, 2) + '\n')
console.log(`已写入 ${OUT}`)
