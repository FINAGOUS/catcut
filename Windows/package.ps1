$ErrorActionPreference = 'Stop'
$shareRoot = Join-Path $PSScriptRoot 'share'
$packageName = 'CatCut-Windows-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$packageRoot = Join-Path $shareRoot $packageName
$zipPath = "$packageRoot.zip"
if (Test-Path -LiteralPath $packageRoot) { throw '同名体验包已存在，请稍后重试。' }

# Explicit file list excludes recordings, projects, tests and personal settings.
$files = @{
    'bin/CatCut.exe' = 'Windows/bin/CatCut.exe'
    'bin/CatCut.exe.config' = 'Windows/bin/CatCut.exe.config'
    'Editor.xaml' = 'Windows/Editor.xaml'
    'EditorTheme.xaml' = 'Windows/EditorTheme.xaml'
    'version.txt' = 'Windows/version.txt'
    'README.md' = 'Windows/README.md'
    'Trial-README.txt' = 'README.txt'
    'tools/ffmpeg.exe' = 'Windows/tools/ffmpeg.exe'
    'tools/ffprobe.exe' = 'Windows/tools/ffprobe.exe'
    'tools/FFmpeg-LICENSE.txt' = 'Windows/tools/FFmpeg-LICENSE.txt'
    'tools/FFmpeg-README.txt' = 'Windows/tools/FFmpeg-README.txt'
    '../docs/third-party/FFmpeg-SOURCE.txt' = 'Windows/tools/FFmpeg-SOURCE.txt'
    # W5：人像遮罩脚本 + 模型、Whisper 转写脚本（随包分发；模型 Apache 2.0，见 THIRD_PARTY_NOTICES.md）。
    'tools/portrait_segment.py' = 'Windows/tools/portrait_segment.py'
    'tools/beauty_mask.py' = 'Windows/tools/beauty_mask.py'
    'tools/transcribe.py' = 'Windows/tools/transcribe.py'
    # W8：TTS 与人声分离脚本（随包分发；模型不随包，需用户另装，见面板说明）。
    'tools/tts.py' = 'Windows/tools/tts.py'
    'tools/vocalsep.py' = 'Windows/tools/vocalsep.py'
    'tools/models/selfie_segmentation_256x256.onnx' = 'Windows/tools/models/selfie_segmentation_256x256.onnx'
    '../THIRD_PARTY_NOTICES.md' = 'THIRD_PARTY_NOTICES.md'
    '../LICENSE' = 'LICENSE'
    '../Resources/Onboarding/SoftLight.png' = 'Resources/Onboarding/SoftLight.png'
    '../Resources/Onboarding/SOURCE.json' = 'Resources/Onboarding/SOURCE.json'
}
foreach ($entry in $files.GetEnumerator()) {
    $source = Join-Path $PSScriptRoot $entry.Key
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少打包文件：$source" }
}
New-Item -ItemType Directory -Path $packageRoot | Out-Null
foreach ($entry in $files.GetEnumerator()) {
    $destination = Join-Path $packageRoot $entry.Value
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $entry.Key) -Destination $destination
}
# W10：VST3 桥 + AGain 测试插件（CI 的 native 步产出；本地只编 C# 时没有，警告不断包——
# 云端构建的 W10 自测会在缺桥时直接 FAIL，所以云端包不可能悄悄缺桥）。
$bridgeFiles = @{
    'bin/Vst3BridgeHost.exe' = 'Windows/bin/Vst3BridgeHost.exe'
    'bin/CatCut.Vst3Bridge.dll' = 'Windows/bin/CatCut.Vst3Bridge.dll'
}
foreach ($entry in $bridgeFiles.GetEnumerator()) {
    $source = Join-Path $PSScriptRoot $entry.Key
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        $destination = Join-Path $packageRoot $entry.Value
        New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
    } else {
        Write-Warning "VST3 桥文件缺失，未随包分发：$source（本地构建需先编 native 桥；云端构建缺它会直接 FAIL）"
    }
}
$againBundle = Join-Path $PSScriptRoot 'bin/Plugins/AGain.vst3'
if (Test-Path -LiteralPath $againBundle -PathType Container) {
    $destination = Join-Path $packageRoot 'Windows/bin/Plugins/AGain.vst3'
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath $againBundle -Destination $destination -Recurse
} else {
    Write-Warning "AGain 测试插件缺失，未随包分发：$againBundle"
}
$fontDestination = Join-Path $packageRoot 'Resources/Fonts'
New-Item -ItemType Directory -Force -Path $fontDestination | Out-Null
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '../Resources/Fonts') -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $fontDestination
}
@'
@echo off
start "" "%~dp0Windows\bin\CatCut.exe"
'@ | Set-Content -LiteralPath (Join-Path $packageRoot 'Start-CatCut.cmd') -Encoding ASCII
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
$packageRoot | Set-Content -LiteralPath (Join-Path $shareRoot 'latest-package-path.txt') -Encoding UTF8
Write-Output "Package: $zipPath"
