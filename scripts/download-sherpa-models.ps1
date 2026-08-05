# 下载 sherpa-onnx WASM + matcha-icefall-zh-en 模型到 public/sherpa/
#
# 用法：
#   pwsh scripts/download-sherpa-models.ps1            # 走默认镜像
#   $env:HF_ENDPOINT='https://hf-mirror.com'; pwsh scripts/download-sherpa-models.ps1
#
# 资源来源：
#   - sherpa-onnx-wasm-main-tts.{js,wasm}: 官方 huggingface space
#   - matcha-icefall-zh-en 模型: github.com/k2-fsa/sherpa-onnx/releases
#
# 资源约 60MB（wasm 8MB + 模型 50MB），下载失败可改 $env:HF_ENDPOINT 走镜像源重试。

[CmdletBinding()]
param(
    [string]$Target = (Resolve-Path "$PSScriptRoot/..\public\sherpa").Path
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # 大文件下载关闭进度条以加速

if (-not (Test-Path $Target)) {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
}

# 镜像源优先级列表；按顺序尝试直到成功
$mirrors = @(
    'https://huggingface.co/csukuangfj/sherpa-onnx-tts-wasm/resolve/main',
    'https://hf-mirror.com/csukuangfj/sherpa-onnx-tts-wasm/resolve/main',
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/sherpa-onnx-wasm-tts'
)

$modelMirrors = @(
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models',
    'https://hf-mirror.com/csukuangfj/sherpa-onnx-tts-models/resolve/main'
)

function Download-File {
    param([string]$Url, [string]$OutFile, [int]$MaxRetries = 3)
    for ($i = 1; $i -le $MaxRetries; $i++) {
        try {
            Write-Host "  Try $i : $Url" -ForegroundColor DarkGray
            Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 300
            return $true
        } catch {
            Write-Host "  fail: $($_.Exception.Message)" -ForegroundColor Yellow
            Start-Sleep -Seconds 2
        }
    }
    return $false
}

function Try-Download-From-Mirrors {
    param([string[]]$Urls, [string]$OutFile)
    foreach ($url in $Urls) {
        if (Download-File -Url $url -OutFile $OutFile) {
            $size = (Get-Item $OutFile).Length
            Write-Host "  ok $size bytes <- $url" -ForegroundColor Green
            return $true
        }
    }
    return $false
}

# --- 1. emscripten WASM glue ---
Write-Host "Step 1/3: 下载 sherpa-onnx-wasm-main-tts.{js,wasm}" -ForegroundColor Cyan
foreach ($f in @('sherpa-onnx-wasm-main-tts.js', 'sherpa-onnx-wasm-main-tts.wasm')) {
    $out = Join-Path $Target $f
    if (Test-Path $out -and (Get-Item $out).Length -gt 0) {
        Write-Host "  exists: $f"
        continue
    }
    $urls = $mirrors | ForEach-Object { "$_/$f" }
    if (-not (Try-Download-From-Mirrors -Urls $urls -OutFile $out)) {
        Write-Error "下载 $f 失败，请手动下载到 $out"
    }
}

# --- 2. matcha-icefall-zh-en 模型包 ---
$modelDir = Join-Path $Target 'models\matcha-zh-en'
if (-not (Test-Path $modelDir)) {
    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
}

Write-Host "Step 2/3: 下载 matcha-icefall-zh-en 模型（约 50MB）" -ForegroundColor Cyan
$modelFiles = @(
    'model-steps-3.onnx',
    'vocos-16khz-univ.onnx',
    'lexicon.txt',
    'tokens.txt',
    'phone-zh.fst',
    'date-zh.fst',
    'number-zh.fst'
)
$needExtract = $false
foreach ($f in $modelFiles) {
    $out = Join-Path $modelDir $f
    if (Test-Path $out -and (Get-Item $out).Length -gt 0) {
        Write-Host "  exists: $f"
        continue
    }
    # 模型文件在 github release 的 tar.bz2 内，单文件无法直链下载
    # 这里走整体 tar.bz2 + 解压策略
    $needExtract = $true
    break
}

if ($needExtract) {
    # 下载完整 tar.bz2
    $tarName = 'matcha-icefall-zh-en.tar.bz2'
    $tarOut = Join-Path $Target $tarName
    if (-not (Test-Path $tarOut) -or (Get-Item $tarOut).Length -lt 1MB) {
        Write-Host "  下载 $tarName（可能耗时数分钟）..." -ForegroundColor DarkGray
        $urls = $modelMirrors | ForEach-Object { "$_/$tarName" }
        if (-not (Try-Download-From-Mirrors -Urls $urls -OutFile $tarOut)) {
            Write-Error "下载 $tarName 失败。可手动从 https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models 下载并解压到 $modelDir"
        }
    }

    Write-Host "  解压..." -ForegroundColor DarkGray
    # Windows 10+ 自带 tar
    $extractDir = Join-Path $Target 'extract-tmp'
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

    & tar -xjf $tarOut -C $extractDir
    if ($LASTEXITCODE -ne 0) {
        Write-Error "解压失败，请确认已安装 tar（Windows 10+ 自带）"
    }

    # 找到 matcha-icefall-zh-en 目录
    $srcDir = Get-ChildItem -Path $extractDir -Directory | Where-Object { $_.Name -like 'matcha-icefall-zh-en*' } | Select-Object -First 1
    if (-not $srcDir) {
        $srcDir = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
    }
    if ($srcDir) {
        Write-Host "  复制到 $modelDir" -ForegroundColor DarkGray
        Copy-Item -Path "$($srcDir.FullName)\*" -Destination $modelDir -Recurse -Force
    }
    Remove-Item -Recurse -Force $extractDir
    Remove-Item -Force $tarOut
}

# --- 3. espeak-ng-data ---
# matcha 模型需要 espeak-ng-data 目录（用于英文字符拼音化）
$espeakDir = Join-Path $modelDir 'espeak-ng-data'
if (-not (Test-Path $espeakDir)) {
    Write-Host "Step 3/3: 下载 espeak-ng-data（约 7MB）" -ForegroundColor Cyan
    $tarName = 'espeak-ng-data.tar.bz2'
    $tarOut = Join-Path $Target $tarName
    if (-not (Test-Path $tarOut) -or (Get-Item $tarOut).Length -lt 1MB) {
        $urls = $modelMirrors | ForEach-Object { "$_/$tarName" }
        if (-not (Try-Download-From-Mirrors -Urls $urls -OutFile $tarOut)) {
            Write-Error "下载 $tarName 失败。"
        }
    }
    & tar -xjf $tarOut -C $modelDir
    if ($LASTEXITCODE -ne 0) {
        Write-Error "解压 espeak-ng-data 失败"
    }
    Remove-Item -Force $tarOut
} else {
    Write-Host "Step 3/3: espeak-ng-data 已存在，跳过" -ForegroundColor DarkGray
}

# --- 完成 ---
Write-Host ""
Write-Host "✓ 资源准备完成" -ForegroundColor Green
Write-Host "目录：$Target" -ForegroundColor Green
Write-Host ""
Write-Host "下一步："
Write-Host "  1. npm run dev 启动本地预览，在「我的」页选择「Matcha · 中英女声」音色"
Write-Host "  2. 若要构建 Android APK：npm run cap:sync"
Write-Host ""
Write-Host "注意："
Write-Host "  - public/sherpa/models/ 下的文件较大，请确保 .gitignore 已忽略（参见仓库根 .gitignore）"
Write-Host "  - 若网络不通，可设 `$env:HF_ENDPOINT='https://hf-mirror.com' 后重跑本脚本"
