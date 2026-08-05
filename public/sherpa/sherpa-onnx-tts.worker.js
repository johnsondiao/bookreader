// Forked from k2-fsa/sherpa-onnx wasm/tts/sherpa-onnx-tts.worker.js
//
// 改动：通过 URL query 参数接收 modelType 与模型基础目录，避免依赖默认 vits 配置。
// 用法：new Worker('/sherpa/sherpa-onnx-tts.worker.js?mt=1&base=/sherpa/models/matcha-zh-en/')
//   - mt=1 → matcha-icefall-zh-en
//   - base → 模型文件（model-steps-3.onnx 等）所在目录
//
// 默认 vits 仍可用：不传 query 即走原行为。

let tts = null;
let modelConfig = null; // 由主线程通过 postMessage 在 onRuntimeInitialized 之前传入

// URL query 解析
const params = new URLSearchParams(self.location.search.replace(/^\?/, ''));
const queryModelType = params.get('mt');
const queryBase = params.get('base');

self.Module = {
  // https://emscripten.org/docs/api_reference/module.html#Module.locateFile
  locateFile: function (path, scriptDirectory = "") {
    // emscripten wasm-main 的 .js/.wasm 都与 worker 同目录
    return scriptDirectory + path;
  },
  // https://emscripten.org/docs/api_reference/module.html#Module.locateFile
  setStatus: function (status) {
    self.postMessage({ type: "sherpa-onnx-tts-progress", status });
  },
  onRuntimeInitialized: function () {
    try {
      // createOfflineTts 在 sherpa-onnx-tts.js 中定义，支持第二个参数 myConfig 覆盖默认
      // 若主线程已通过 'init' 消息下发 modelConfig，优先使用；否则按 URL query 走 matcha/vits 默认。
      let myConfig = modelConfig;
      if (!myConfig && queryModelType) {
        myConfig = buildMatchaConfigFromBase(queryBase || './');
      }
      if (myConfig) {
        tts = createOfflineTts(self.Module, myConfig);
      } else {
        tts = createOfflineTts(self.Module);
      }
      self.postMessage({
        type: "sherpa-onnx-tts-ready",
        modelType: getDefaultOfflineTtsModelType(),
        numSpeakers: tts.numSpeakers,
      });
    } catch (e) {
      self.postMessage({
        type: "error",
        message: "TTS Initialization failed: " + e.message,
      });
    }
  },
};
importScripts("sherpa-onnx-wasm-main-tts.js");
importScripts("sherpa-onnx-tts.js");

/**
 * 由 base 目录构造 matcha-icefall-zh-en 的 OfflineTtsConfig。
 * base 下的文件列表（与官方一致）：
 *   - model-steps-3.onnx
 *   - vocos-16khz-univ.onnx
 *   - lexicon.txt
 *   - tokens.txt
 *   - espeak-ng-data/        （目录）
 *   - phone-zh.fst, date-zh.fst, number-zh.fst
 */
function buildMatchaConfigFromBase(base) {
  const matcha = {
    acousticModel: base + 'model-steps-3.onnx',
    vocoder: base + 'vocos-16khz-univ.onnx',
    lexicon: base + 'lexicon.txt',
    tokens: base + 'tokens.txt',
    dataDir: base + 'espeak-ng-data',
    noiseScale: 0.667,
    lengthScale: 1.0,
  };
  const ruleFsts = [
    base + 'phone-zh.fst',
    base + 'date-zh.fst',
    base + 'number-zh.fst',
  ].join(',');
  return {
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: {
        model: '', lexicon: '', tokens: '', dataDir: '',
        noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0,
      },
      offlineTtsMatchaModelConfig: matcha,
      offlineTtsKokoroModelConfig: { model: '', voices: '', tokens: '', dataDir: '', lengthScale: 1.0, lexicon: '', lang: '' },
      offlineTtsKittenModelConfig: { model: '', voices: '', tokens: '', dataDir: '', lengthScale: 1.0 },
      offlineTtsZipVoiceModelConfig: { tokens: '', encoder: '', decoder: '', vocoder: '', dataDir: '', lexicon: '', featScale: 0.1, tShift: 0.5, targetRMS: 0.1, guidanceScale: 1.0 },
      offlineTtsPocketModelConfig: { lmFlow: '', lmMain: '', encoder: '', decoder: '', textConditioner: '', vocabJson: '', tokenScoresJson: '', voiceEmbeddingCacheCapacity: 50 },
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
    },
    ruleFsts: ruleFsts,
    ruleFars: '',
    maxNumSentences: 1,
  };
}

function getErrorMessage(err) {
  if (err instanceof Error) {
    if (err.stack) {
      return `${err.message}\n${err.stack}`;
    }
    return err.message;
  }
  return `${err}`;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const { type, text, sid, speed, genConfig, reqId } = msg;
  if (type == "generate") {
    if (!tts) {
      return;
    }
    try {
      const audio = tts.generate({
        text: text,
        sid: sid || 0,
        speed: speed || 1.0,
      });
      const samples = audio.samples;
      const sampleRate = tts.sampleRate;
      self.postMessage(
        {
          type: "sherpa-onnx-tts-result",
          reqId: reqId,
          samples: samples,
          sampleRate: sampleRate,
        },
        [samples.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: "error",
        reqId: reqId,
        message: "Generation failed: " + getErrorMessage(err),
      });
    }
  } else if (type == "generateWithConfig") {
    if (!tts) {
      return;
    }
    try {
      const config = Object.assign({}, genConfig || {});
      config.callback = (samples, n, progress) => {
        self.postMessage({
          type: "sherpa-onnx-tts-generation-progress",
          progress: progress,
        });
        return 1;
      };

      const audio = tts.generateWithConfig(text, config);
      const samples = audio.samples;
      const sampleRate = audio.sampleRate;
      self.postMessage(
          {
            type: "sherpa-onnx-tts-result",
            reqId: reqId,
            samples: samples,
            sampleRate: sampleRate,
          },
          [samples.buffer],
        );
    } catch (err) {
      self.postMessage({
        type: "error",
        reqId: reqId,
        message: "Generation failed: " + getErrorMessage(err),
      });
    }
  }
};
