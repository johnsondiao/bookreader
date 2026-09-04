package com.johnsondiao.bookreader

import android.content.res.AssetManager
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsMatchaModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 本地神经网络 TTS（sherpa-onnx，ONNX Runtime 原生推理）。
 *
 * 为什么走原生而不是 WebView 里的 WASM：历史上试过 piper-tts-web + onnxruntime-web，
 * 代价是 145MB 资源塞进 APK，且 Emscripten 用 XHR 加载 wasm/data 绕过 fetch 改写导致
 * 静默播放、音色切换触发单例重载每段延迟数秒。原生层这些坑都不存在。
 *
 * 模型文件清单见 assets/tts-models/manifest.json（scripts/gen-tts-manifest.mjs 生成）：
 * 随包模型（melo）由 CI 构建前拉进 assets，其余模型在 App 内按需下载。
 * 逐模型的推理配置严格照抄 sherpa-onnx 官方 Android 示例
 * （scripts/apk/generate-tts-apk-script.py 与 SherpaOnnxTtsEngine 的 TtsEngine.kt），
 * 不要凭印象改文件名单复数或 fst 名字。
 */
@CapacitorPlugin(name = "LocalTts")
class LocalTtsPlugin : Plugin() {

    /** 展示信息；文件清单与体积来自 manifest.json */
    private data class ModelSpec(
        val id: String,
        val name: String,
        val desc: String,
        val speakers: Int,
        val sampleRate: Int,
    )

    private data class ManifestFile(val rel: String, val url: String, val size: Long)

    private data class ManifestModel(
        val id: String,
        val bundled: Boolean,
        val files: List<ManifestFile>,
        val totalBytes: Long,
    )

    private companion object {
        const val TAG = "LocalTts"
        const val MANIFEST_PATH = "tts-models/manifest.json"
        /** manifest 里的下载地址默认走 hf-mirror；用户可在设置里换镜像前缀 */
        const val DEFAULT_MIRROR = "https://hf-mirror.com"

        val SPECS = listOf(
            ModelSpec("vits-melo-tts-zh_en", "MeloTTS 中英", "44.1kHz 女声，中英混排自然，随安装包提供", 1, 44100),
            ModelSpec("matcha-icefall-zh-baker", "Matcha 标贝", "22kHz 女声，合成速度最快", 1, 22050),
            ModelSpec("kokoro-int8-multi-lang-v1_1", "Kokoro 多语", "24kHz，音质最好，103 个音色", 103, 24000),
        )
    }

    /** 当前已加载的引擎；换模型/释放时 free */
    private var tts: OfflineTts? = null
    private var loadedModelId: String? = null
    private val lock = Any()
    private var manifestCache: List<ManifestModel>? = null

    /* ==================== 清单与模型状态 ==================== */

    private fun loadManifest(): List<ManifestModel> {
        manifestCache?.let { return it }
        val text = context.assets.open(MANIFEST_PATH).bufferedReader().use { it.readText() }
        val root = org.json.JSONObject(text)
        val arr = root.getJSONArray("models")
        val out = ArrayList<ManifestModel>(arr.length())
        for (i in 0 until arr.length()) {
            val m = arr.getJSONObject(i)
            val fa = m.getJSONArray("files")
            val files = ArrayList<ManifestFile>(fa.length())
            for (j in 0 until fa.length()) {
                val f = fa.getJSONObject(j)
                files.add(ManifestFile(f.getString("rel"), f.getString("url"), f.optLong("size", 0)))
            }
            out.add(ManifestModel(m.getString("id"), m.optBoolean("bundled", false), files, m.optLong("totalBytes", 0)))
        }
        manifestCache = out
        return out
    }

    private fun manifestOf(modelId: String): ManifestModel? = loadManifest().firstOrNull { it.id == modelId }

    private fun specOf(modelId: String): ModelSpec? = SPECS.firstOrNull { it.id == modelId }

    private fun modelRoot(modelId: String): File = File(context.filesDir, "tts-models/$modelId")

    private fun isReady(m: ManifestModel): Boolean {
        return if (m.bundled) {
            try {
                val names = context.assets.list("tts-models/${m.id}")?.toSet() ?: emptySet()
                m.files.all { names.contains(it.rel) }
            } catch (e: Exception) {
                Log.w(TAG, "读 assets 清单失败 ${m.id}", e)
                false
            }
        } else {
            val dir = modelRoot(m.id)
            m.files.all { File(dir, it.rel).let { f -> f.isFile && f.length() > 0 } }
        }
    }

    private fun installedBytes(m: ManifestModel): Long {
        return if (m.bundled) {
            // 压缩过的 asset 不能 openFd 取长度；随包模型就绪即等于清单总体积
            if (isReady(m)) m.totalBytes else 0L
        } else {
            val dir = modelRoot(m.id)
            if (!dir.exists()) 0L else dir.walkTopDown().sumOf { if (it.isFile) it.length() else 0L }
        }
    }

    @PluginMethod
    fun getModels(call: PluginCall) {
        val arr = org.json.JSONArray()
        for (spec in SPECS) {
            val m = manifestOf(spec.id)
            val o = JSObject()
            o.put("id", spec.id)
            o.put("name", spec.name)
            o.put("desc", spec.desc)
            o.put("speakers", spec.speakers)
            o.put("sampleRate", spec.sampleRate)
            o.put("bundled", m?.bundled == true)
            o.put("ready", m != null && isReady(m))
            o.put("loaded", loadedModelId == spec.id)
            o.put("totalBytes", m?.totalBytes ?: 0)
            o.put("installedBytes", if (m == null) 0L else installedBytes(m))
            arr.put(o)
        }
        call.resolve(JSObject().apply { put("models", arr) })
    }

    /* ==================== 下载 / 删除 ==================== */

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val modelId = call.getString("modelId") ?: return call.reject("modelId required")
        val m = manifestOf(modelId) ?: return call.reject("清单里没有模型 $modelId")
        if (m.bundled) return call.reject("该模型已随安装包提供，无需下载")
        val mirror = call.getString("mirror")?.takeIf { it.isNotBlank() }?.trimEnd('/')

        val dir = modelRoot(modelId)
        dir.mkdirs()
        var done = 0L
        val total = m.totalBytes

        for ((idx, f) in m.files.withIndex()) {
            val target = File(dir, f.rel)
            if (target.isFile && target.length() > 0) {
                done += target.length()
                continue
            }
            target.parentFile?.mkdirs()
            try {
                downloadToFile(mirrorUrl(f.url, mirror), target) { written, fileTotal ->
                    emitProgress(modelId, f.rel, idx + 1, m.files.size, done + written, total, fileTotal)
                }
                done += target.length()
            } catch (e: Exception) {
                Log.e(TAG, "下载失败 ${f.rel}", e)
                target.delete()
                return call.reject("下载 ${f.rel} 失败：${e.message}")
            }
        }
        call.resolve(JSObject().apply { put("ok", true); put("bytes", done) })
    }

    private fun mirrorUrl(url: String, mirror: String?): String {
        if (mirror.isNullOrBlank() || mirror == DEFAULT_MIRROR) return url
        return if (url.startsWith(DEFAULT_MIRROR)) mirror + url.substring(DEFAULT_MIRROR.length) else url
    }

    private fun downloadToFile(
        url: String,
        target: File,
        onProgress: (written: Long, total: Long) -> Unit,
    ) {
        val tmp = File(target.parentFile, target.name + ".part")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000
            readTimeout = 60000
            instanceFollowRedirects = true
        }
        try {
            conn.inputStream.use { input ->
                FileOutputStream(tmp).use { out ->
                    val buf = ByteArray(64 * 1024)
                    var written = 0L
                    val total = conn.contentLengthLong.coerceAtLeast(0)
                    var lastReport = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        written += n
                        // 每 512KB 回调一次，避免桥接事件洪水
                        if (written - lastReport >= 512 * 1024) {
                            lastReport = written
                            onProgress(written, total)
                        }
                    }
                    onProgress(written, total)
                }
            }
        } finally {
            conn.disconnect()
        }
        if (!tmp.renameTo(target)) throw IllegalStateException("写入失败：${target.name}")
    }

    private fun emitProgress(
        modelId: String,
        file: String,
        fileIdx: Int,
        fileCount: Int,
        done: Long,
        total: Long,
        fileTotal: Long,
    ) {
        notifyListeners(
            "downloadProgress",
            JSObject().apply {
                put("modelId", modelId)
                put("file", file)
                put("fileIndex", fileIdx)
                put("fileCount", fileCount)
                put("done", done)
                put("total", total)
                put("fileTotal", fileTotal)
            },
        )
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        val modelId = call.getString("modelId") ?: return call.reject("modelId required")
        val m = manifestOf(modelId) ?: return call.reject("清单里没有模型 $modelId")
        if (m.bundled) return call.reject("随安装包的模型不能删除")
        synchronized(lock) {
            if (loadedModelId == modelId) {
                tts?.free()
                tts = null
                loadedModelId = null
            }
        }
        modelRoot(modelId).deleteRecursively()
        call.resolve(JSObject().apply { put("ok", true) })
    }

    /* ==================== 推理 ==================== */

    @PluginMethod
    fun init(call: PluginCall) {
        val modelId = call.getString("modelId") ?: return call.reject("modelId required")
        val spec = specOf(modelId) ?: return call.reject("未知模型 $modelId")
        val m = manifestOf(modelId) ?: return call.reject("清单里没有模型 $modelId")
        if (!isReady(m)) return call.reject("模型未就绪：${spec.name}，请先在设置里下载")
        val threads = call.getInt("threads") ?: if (modelId.startsWith("kokoro")) 4 else 2

        synchronized(lock) {
            if (loadedModelId == modelId && tts != null) {
                call.resolve(infoObject(spec))
                return
            }
            tts?.free()
            tts = null
            loadedModelId = null

            val assets: AssetManager?
            val dir: String
            if (m.bundled) {
                assets = context.assets
                dir = "tts-models/$modelId"
            } else {
                assets = null
                dir = modelRoot(modelId).absolutePath
            }
            try {
                // 模型加载是 CPU/IO 密集（int8 melo 约 1-2 秒）；插件方法默认在后台线程执行
                tts = OfflineTts(assetManager = assets, config = buildConfig(modelId, dir, threads))
                loadedModelId = modelId
                Log.i(TAG, "loaded $modelId sampleRate=${tts?.sampleRate()} speakers=${tts?.numSpeakers()}")
            } catch (e: Exception) {
                Log.e(TAG, "加载模型失败 $modelId", e)
                call.reject("加载模型失败：${e.message}")
                return
            }
        }
        call.resolve(infoObject(spec))
    }

    private fun infoObject(spec: ModelSpec): JSObject {
        val t = tts
        return JSObject().apply {
            put("modelId", spec.id)
            put("sampleRate", t?.sampleRate() ?: spec.sampleRate)
            put("speakers", t?.numSpeakers() ?: spec.speakers)
        }
    }

    /**
     * 逐模型配置，与 sherpa-onnx 官方 Android APK 生成脚本一致：
     *  - melo：vits + lexicon + tokens（官方不传 ruleFsts/dict）
     *  - baker：matcha 声学模型 + vocos 声码器 + ruleFsts(phone,date,number)
     *  - kokoro：model + voices.bin + 双 lexicon + ruleFsts(*-zh) + espeak-ng-data
     */
    private fun buildConfig(modelId: String, dir: String, threads: Int): OfflineTtsConfig {
        return when (modelId) {
            "vits-melo-tts-zh_en" -> OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    vits = OfflineTtsVitsModelConfig(
                        model = "$dir/model.int8.onnx",
                        lexicon = "$dir/lexicon.txt",
                        tokens = "$dir/tokens.txt",
                    ),
                    numThreads = threads,
                ),
            )

            "matcha-icefall-zh-baker" -> OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    matcha = OfflineTtsMatchaModelConfig(
                        acousticModel = "$dir/model-steps-3.onnx",
                        vocoder = "$dir/vocos-22khz-univ.onnx",
                        lexicon = "$dir/lexicon.txt",
                        tokens = "$dir/tokens.txt",
                    ),
                    numThreads = threads,
                ),
                ruleFsts = "$dir/phone.fst,$dir/date.fst,$dir/number.fst",
            )

            "kokoro-int8-multi-lang-v1_1" -> OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    kokoro = OfflineTtsKokoroModelConfig(
                        model = "$dir/model.int8.onnx",
                        voices = "$dir/voices.bin",
                        tokens = "$dir/tokens.txt",
                        dataDir = "$dir/espeak-ng-data",
                        lexicon = "$dir/lexicon-us-en.txt,$dir/lexicon-zh.txt",
                    ),
                    numThreads = threads,
                ),
                ruleFsts = "$dir/phone-zh.fst,$dir/date-zh.fst,$dir/number-zh.fst",
            )

            else -> throw IllegalArgumentException("未支持的模型 $modelId")
        }
    }

    @PluginMethod
    fun synth(call: PluginCall) {
        val text = call.getString("text") ?: return call.reject("text required")
        val sid = call.getInt("sid") ?: 0
        val speed = call.getFloat("speed") ?: 1.0f
        val engine = synchronized(lock) { tts }
        if (engine == null) return call.reject("本地引擎未初始化，请先 init")
        try {
            val audio = synchronized(lock) { engine.generate(text, sid, speed) }
            val wav = encodeWav(audio.samples, audio.sampleRate)
            call.resolve(
                JSObject().apply {
                    put("wavBase64", Base64.encodeToString(wav, Base64.NO_WRAP))
                    put("sampleRate", audio.sampleRate)
                    put("samples", audio.samples.size)
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "合成失败", e)
            call.reject("本地合成失败：${e.message}")
        }
    }

    @PluginMethod
    fun release(call: PluginCall) {
        synchronized(lock) {
            tts?.free()
            tts = null
            loadedModelId = null
        }
        call.resolve(JSObject().apply { put("ok", true) })
    }

    /** Float32 [-1,1] → 16-bit PCM WAV（小端），播放端 <audio> 直接能吃 */
    private fun encodeWav(samples: FloatArray, sampleRate: Int): ByteArray {
        val pcm = ShortArray(samples.size)
        for (i in samples.indices) {
            pcm[i] = (samples[i] * 32767f).coerceIn(-32768f, 32767f).toInt().toShort()
        }
        val buf = ByteBuffer.allocate(44 + pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray(Charsets.US_ASCII))
        buf.putInt(36 + pcm.size * 2)
        buf.put("WAVE".toByteArray(Charsets.US_ASCII))
        buf.put("fmt ".toByteArray(Charsets.US_ASCII))
        buf.putInt(16)
        buf.putShort(1) // PCM
        buf.putShort(1) // mono
        buf.putInt(sampleRate)
        buf.putInt(sampleRate * 2)
        buf.putShort(2)
        buf.putShort(16)
        buf.put("data".toByteArray(Charsets.US_ASCII))
        buf.putInt(pcm.size * 2)
        for (s in pcm) buf.putShort(s)
        return buf.array()
    }
}
