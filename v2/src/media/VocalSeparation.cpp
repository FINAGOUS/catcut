#include "media/VocalSeparation.h"

#include <QFileInfo>

namespace catcut {

bool VocalSeparator::isAvailable()
{
    return false;
}

QString VocalSeparator::setupInstructions()
{
    return QStringLiteral(
        "人声分离 (Demucs) 尚未接入：\n"
        "1. python3 -m venv .venv && .venv/bin/pip install torch torchaudio "
        "--index-url https://download.pytorch.org/whl/cpu\n"
        "2. .venv/bin/pip install demucs\n"
        "3. 首次运行会从 Meta 的托管下载模型权重（htdemucs，约 400 MB）到 torch hub 缓存；\n"
        "   Demucs 本身是 MIT 协议，但模型权重是独立产物，公开发行前必须重新核查其再分发条款，\n"
        "   权重不得随安装包捆绑分发。\n"
        "4. 接入后：对源音频跑 `python -m demucs --two-stems vocals <源文件>`，\n"
        "   得到 vocals.wav / no_vocals.wav 两个 stem，再作为普通音频片段放回时间线混音。\n"
        "注意：不要用中心声道切除之类的滤波假装人声分离——那不是人声分离。");
}

bool VocalSeparator::separate(const QString& sourcePath, const QString& /*outDir*/,
                              QString& /*vocalsPath*/, QString& /*accompanimentPath*/,
                              QString& error)
{
    if (!QFileInfo::exists(sourcePath)) {
        error = QStringLiteral("人声分离：源文件不存在：%1").arg(sourcePath);
        return false;
    }
    error = QStringLiteral("人声分离未接入：没有连接的分离后端，无法分离，也不会返回假的 stem。\n")
        + setupInstructions();
    return false;
}

} // namespace catcut
