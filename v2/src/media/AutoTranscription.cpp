#include "media/AutoTranscription.h"

#include "core/Subtitles.h"

#include <QFileInfo>

namespace catcut {

bool AutoTranscriber::isAvailable()
{
    return false;
}

QString AutoTranscriber::setupInstructions()
{
    return QStringLiteral(
        "自动识别字幕 (whisper) 尚未接入：\n"
        "计划路线（v2 任务书）：把 whisper.cpp 作为源码库 vendored 进来，\n"
        "在 CI 上干净编译通过后才留用；编不过就继续留 hook，不硬编。\n"
        "替代路线（旧引擎 transcribe.ts 已验证）：faster-whisper Python 助手：\n"
        "1. python3 -m venv .venv && .venv/bin/pip install faster-whisper\n"
        "2. 首次运行从 Hugging Face 下载模型（tiny 约 75 MB，small 约 466 MB，medium 约 1.5 GB），无需账号。\n"
        "3. 先把音频解码成 16 kHz 单声道 PCM 再识别；中文用 small 及以上模型，\n"
        "   tiny 在中文上实测字错率很高，不能作为中文默认。\n"
        "4. faster-whisper 输出繁体字，烧录前必须转简体。\n"
        "接入后：识别结果填进 SubtitleTrack（带时间戳的 SubtitleItem），\n"
        "字幕模型、SRT 导入导出与烧录已就绪，无需再改渲染路径。");
}

bool AutoTranscriber::transcribe(const QString& audioPath, const QString& /*language*/,
                                 QList<SubtitleItem>& /*itemsOut*/, QString& error)
{
    if (!QFileInfo::exists(audioPath)) {
        error = QStringLiteral("自动识别字幕：音频文件不存在：%1").arg(audioPath);
        return false;
    }
    error = QStringLiteral("自动识别字幕未接入：没有连接的识别模型，无法识别，也不会返回假的字幕。\n")
        + setupInstructions();
    return false;
}

} // namespace catcut
