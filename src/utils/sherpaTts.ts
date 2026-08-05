/**
 * Sherpa-ONNX WASM TTS 包装器
 *
 * 设计：每个 SherpaTtsWorker 实例对应一个 matcha-icefall-zh-en 模型 + worker。
 * - 创建时 worker 自动开始下载 wasm 与初始化
 * - 主线程通过 generate(text, sid, speed) 提交句子，等待 result/error 事件
 * - 单 worker 串行处理；上层 tts.ts 用双缓冲并行合成下一句
 *
 * 资源依赖（需运行 scripts/download-sherpa-models.ps1 后才存在）：
 *   public/sherpa/sherpa-onnx-wasm-main-tts.js     ← emscripten 胶水（约 30KB）
 *   public/sherpa/sherpa-onnx-wasm-main-tts.wasm  ← emscripten 二进制（约 8MB）
 *   public/sherpa/sherpa-onnx-tts.js               ← sherpa 配置 JS（已内置）
 *   public/sherpa/sherpa-onnx-tts.worker.js        ← worker 入口（已改写）
 *   public/sherpa/models/matcha-zh-en/
 *     ├─ model-steps-3.onnx
 *     ├─ vocos-16khz-univ.onnx
 *     ├─ lexicon.txt
 *     ├─ tokens.txt
 *     ├─ espeak-ng-data/
 *     ├─ phone-zh.fst
 *     ├─ date-zh.fst
 *     └─ number-zh.fst
 */

import { agentLog } from './agentLog'

export type SherpaProgress = {
  stage: string
  progress: number
  message: string
}

export type SherpaAudio = {
  samples: Float32Array
  sampleRate: number
}

type ResolveFn = (audio: SherpaAudio) => void
type RejectFn = (err: Error) => void

/**
 * Worker 当前请求的 reqId。每次 generate 递增，随消息下发并由 worker 回传。
 * 用于丢弃 stop/abort 后 worker 迟到的旧结果，避免错配到新请求。
 */
class SherpaAbortError extends Error {
  constructor() {
    super('aborted')
    this.name = 'SpeakAborted'
  }
}

const STATUS_TIMEOUT_MS = 60_000 // ready 阶段 wasm 下载 + 模型 init 不应超过 1 分钟

export class SherpaTtsWorker {
  private worker: Worker | null = null
  private ready: boolean = false
  private readyResolvers: Array<() => void> = []
  private readyRejectors: Array<(e: Error) => void> = []
  private currentResolve: ResolveFn | null = null
  private currentReject: RejectFn | null = null
  private currentReqId = 0
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private onProgress?: (p: SherpaProgress) => void
  private readonly workerUrl: string
  private readonly modelBase: string

  constructor(opts: {
    /** 模型文件所在 URL 基础路径，相对站点根目录，必须以 / 结尾 */
    modelBase: string
    onProgress?: (p: SherpaProgress) => void
  }) {
    this.modelBase = opts.modelBase
    this.onProgress = opts.onProgress
    // 通过 URL query 把 base 传给 worker，避免时序竞态
    const q = new URLSearchParams({ mt: '1', base: this.modelBase })
    const base = import.meta.env.BASE_URL || '/'
    this.workerUrl = `${base.replace(/\/$/, '')}/sherpa/sherpa-onnx-tts.worker.js?${q.toString()}`
  }

  /** 启动 worker，等待 sherpa-onnx-tts-ready */
  async init(): Promise<void> {
    if (this.worker) return
    // #region agent log
    agentLog('sherpaTts:init', 'start', { workerUrl: this.workerUrl, modelBase: this.modelBase }, 'C')
    // #endregion
    this.worker = new Worker(this.workerUrl, { type: 'classic' })
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e)
    this.worker.onerror = (e: ErrorEvent) => {
      const err = new Error(`worker error: ${e.message || 'unknown'}`)
      // #region agent log
      agentLog('sherpaTts:init', 'onerror', { message: e.message, filename: e.filename, lineno: e.lineno }, 'C')
      // #endregion
      this.failAll(err)
    }

    // ready 超时保护
    this.readyTimer = setTimeout(() => {
      if (!this.ready) {
        this.failAll(new Error('sherpa-onnx worker 启动超时（60s），可能是 wasm 或模型下载失败'))
      }
    }, STATUS_TIMEOUT_MS)

    await new Promise<void>((resolve, reject) => {
      this.readyResolvers.push(resolve)
      this.readyRejectors.push(reject)
    })
  }

  private onMessage(e: MessageEvent) {
    const data = e.data || {}
    // #region agent log
    agentLog('sherpaTts:onMessage', data.type || 'unknown', data, 'D')
    // #endregion
    switch (data.type) {
      case 'sherpa-onnx-tts-progress': {
        const status: string = data.status || ''
        // emscripten 状态：'Downloading data... (n/m)' 或 'Running...'
        const m = status.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/)
        if (m) {
          const pct = Number(m[2]) === 0 ? 0 : Number(m[1]) / Number(m[2])
          this.onProgress?.({ stage: 'wasm', progress: pct, message: `下载 WASM ${(pct * 100).toFixed(0)}%` })
        } else if (status.includes('Running')) {
          this.onProgress?.({ stage: 'init', progress: 0.5, message: '初始化引擎…' })
        }
        break
      }
      case 'sherpa-onnx-tts-ready': {
        this.ready = true
        if (this.readyTimer) {
          clearTimeout(this.readyTimer)
          this.readyTimer = null
        }
        // #region agent log
        agentLog('sherpaTts:onMessage', 'ready', { numSpeakers: data.numSpeakers, modelType: data.modelType }, 'A')
        // #endregion
        this.onProgress?.({ stage: 'ready', progress: 1, message: 'Sherpa 引擎已就绪' })
        const rs = this.readyResolvers
        this.readyResolvers = []
        this.readyRejectors = []
        rs.forEach((r) => r())
        break
      }
      case 'sherpa-onnx-tts-result': {
        // 丢弃 stop/abort 后 worker 迟到的旧结果，避免错配到新请求
        const reqId = data.reqId as number | undefined
        if (reqId !== undefined && reqId !== this.currentReqId) {
          break
        }
        const resolve = this.currentResolve
        this.currentResolve = null
        this.currentReject = null
        if (resolve) {
          const samples = data.samples as Float32Array
          const sampleRate = data.sampleRate as number
          resolve({ samples, sampleRate })
        }
        break
      }
      case 'sherpa-onnx-tts-generation-progress': {
        const progress = (data.progress || 0) as number
        this.onProgress?.({ stage: 'synth', progress, message: `合成 ${Math.round(progress * 100)}%` })
        break
      }
      case 'error': {
        const msg = (data.message as string) || 'unknown error'
        // #region agent log
        agentLog('sherpaTts:onMessage', 'error', { message: msg }, 'C')
        // #endregion
        if (!this.ready) {
          // init 阶段错误
          if (this.readyTimer) {
            clearTimeout(this.readyTimer)
            this.readyTimer = null
          }
          const rjs = this.readyRejectors
          this.readyRejectors = []
          this.readyResolvers = []
          rjs.forEach((r) => r(new Error(msg)))
        } else if (this.currentReject) {
          const rj = this.currentReject
          this.currentResolve = null
          this.currentReject = null
          rj(new Error(msg))
        }
        break
      }
      default:
        break
    }
  }

  private failAll(err: Error) {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    const rjs = this.readyRejectors
    this.readyRejectors = []
    this.readyResolvers = []
    rjs.forEach((r) => r(err))
    if (this.currentReject) {
      const rj = this.currentReject
      this.currentResolve = null
      this.currentReject = null
      rj(err)
    }
  }

  /**
   * 合成一段文本，返回 PCM 浮点样本。
   * 调用方应自行控制并发：本 worker 同一时刻只能处理一条 generate。
   */
  async generate(text: string, sid = 0, speed = 1.0): Promise<SherpaAudio> {
    if (!this.worker || !this.ready) {
      throw new Error('sherpa worker 未就绪')
    }
    return new Promise<SherpaAudio>((resolve, reject) => {
      if (this.currentResolve || this.currentReject) {
        reject(new Error('sherpa worker 正在合成上一句，请等待完成'))
        return
      }
      const reqId = ++this.currentReqId
      this.currentResolve = resolve
      this.currentReject = reject
      this.worker!.postMessage({ type: 'generate', text, sid, speed, reqId })
    })
  }

  /**
   * 中止当前 pending 的 generate（如果存在）。
   * 不销毁 worker；worker 内部合成仍会跑完，但结果被丢弃。
   * 用于 stop() 让上层 Promise 立刻 reject，不必等 worker 跑完。
   */
  abortCurrent() {
    if (this.currentReject) {
      const rj = this.currentReject
      this.currentResolve = null
      this.currentReject = null
      // 抛 SpeakAborted 让上层 tts.speak() 一致识别为"用户停止"，不冒泡成错误
      rj(new SherpaAbortError())
    }
  }

  /** 销毁 worker，释放内存 */
  terminate() {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.ready = false
    this.currentResolve = null
    this.currentReject = null
    this.readyResolvers = []
    this.readyRejectors = []
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
  }

  isReady(): boolean {
    return this.ready
  }
}
