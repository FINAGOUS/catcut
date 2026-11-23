#include "media/VocalSeparation.h"

#include "media/AudioDecoder.h"
#include "media/ExportPipeline.h"
#include "media/MediaProbe.h"

#include <QDir>
#include <QFileInfo>
#include <cmath>

namespace catcut {

bool VocalSeparator::isAvailable()
{
    return true;
}

QString VocalSeparator::methodDescription()
{
    return QStringLiteral("中置声道消除（非 AI）");
}

QString VocalSeparator::setupInstructions()
{
    return QStringLiteral(
        "人声分离当前用内置的中置声道消除（非 AI）：立体声左右声道相减，\n"
        "抵消掉居中的人声，输出音乐轨；居中的内容另存为 _center.wav。\n"
        "它不是 AI 分离：居中乐器也会被一起消掉，非居中的人声消不掉，\n"
        "单声道素材无法分离。\n"
        "后续 AI 路线（Demucs，本轮不做）：\n"
        "1. python3 -m venv .venv && .venv/bin/pip install torch torchaudio "
        "--index-url https://download.pytorch.org/whl/cpu\n"
        "2. .venv/bin/pip install demucs\n"
        "3. 首次运行会从 Meta 的托管下载模型权重（htdemucs，约 400 MB）到 torch hub 缓存；\n"
        "   Demucs 本身是 MIT 协议，但模型权重是独立产物，公开发行前必须重新核查其再分发条款，\n"
        "   权重不得随安装包捆绑分发。\n"
        "4. 接入后：对源音频跑 `python -m demucs --two-stems vocals <源文件>`，\n"
        "   得到 vocals.wav / no_vocals.wav 两个 stem，再作为普通音频片段放回时间线混音。");
}

bool VocalSeparator::separate(const QString& sourcePath, const QString& outDir,
                              QString& vocalsPath, QString& accompanimentPath,
                              QString& error)
{
    vocalsPath.clear();
    accompanimentPath.clear();
    if (!QFileInfo::exists(sourcePath)) {
        error = QStringLiteral("人声分离：源文件不存在：%1").arg(sourcePath);
        return false;
    }
    QDir dir(outDir);
    if (!dir.exists() && !QDir().mkpath(outDir)) {
        error = QStringLiteral("人声分离：无法创建输出目录：%1").arg(outDir);
        return false;
    }
    // Mono check on the SOURCE channels, not the decoded mix:
    // AudioDecoder always resamples to stereo, so a mono file would
    // decode to L == R and the music track would come out silent —
    // a misleading "success". Probe the container first.
    const MediaInfo probed = MediaProbe::probe(sourcePath);
    if (probed.ok && probed.hasAudio && probed.audioChannels == 1) {
        error = QStringLiteral("人声分离：源音频是单声道，中置声道消除需要左右两个声道。");
        return false;
    }
    DecodedAudio decoded;
    QString decodeError;
    if (!AudioDecoder::decodeAll(sourcePath, decoded, decodeError)) {
        error = QStringLiteral("人声分离：无法解码源音频：%1").arg(decodeError);
        return false;
    }
    if (decoded.channels != 2) {
        error = QStringLiteral("人声分离：源音频不是立体声（%1 声道），中置声道消除需要左右两个声道。")
                      .arg(decoded.channels);
        return false;
    }
    const int frames = decoded.frameCount();
    if (frames <= 0) {
        error = QStringLiteral("人声分离：源音频没有可分离的采样。");
        return false;
    }
    DecodedAudio music;
    music.sampleRate = decoded.sampleRate;
    music.channels = 2;
    music.samples.resize(decoded.samples.size());
    DecodedAudio centre;
    centre.sampleRate = decoded.sampleRate;
    centre.channels = 2;
    centre.samples.resize(decoded.samples.size());
    for (int i = 0; i < frames; ++i) {
        const float left = decoded.samples[static_cast<qsizetype>(i) * 2];
        const float right = decoded.samples[static_cast<qsizetype>(i) * 2 + 1];
        const float diff = (left - right) * 0.5f; // centre cancels
        const float mid = (left + right) * 0.5f;  // centre content
        music.samples[static_cast<qsizetype>(i) * 2] = diff;
        music.samples[static_cast<qsizetype>(i) * 2 + 1] = -diff;
        centre.samples[static_cast<qsizetype>(i) * 2] = mid;
        centre.samples[static_cast<qsizetype>(i) * 2 + 1] = mid;
    }
    const QString base = QFileInfo(sourcePath).completeBaseName();
    const QString musicPath = dir.filePath(base + QStringLiteral("_music.wav"));
    const QString centrePath = dir.filePath(base + QStringLiteral("_center.wav"));
    QString writeError;
    if (!ExportPipeline::writeWav(musicPath, music, writeError)) {
        error = QStringLiteral("人声分离：%1").arg(writeError);
        return false;
    }
    if (!ExportPipeline::writeWav(centrePath, centre, writeError)) {
        error = QStringLiteral("人声分离：%1").arg(writeError);
        return false;
    }
    // `vocalsPath` is the extracted CENTRE content (voice + centred
    // instruments), not isolated vocals — the name is the legacy API
    // slot; the UI and docs must not present it as AI-separated vocals.
    vocalsPath = centrePath;
    accompanimentPath = musicPath;
    return true;
}

} // namespace catcut
