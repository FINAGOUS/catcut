#include "core/ExportPreset.h"

#include <algorithm>
#include <cmath>

namespace catcut {

QString videoCodecName(VideoCodec codec)
{
    return codec == VideoCodec::H265 ? QStringLiteral("hevc") : QStringLiteral("h264");
}

VideoCodec videoCodecFromName(const QString& name, VideoCodec fallback)
{
    if (name == QStringLiteral("hevc") || name == QStringLiteral("h265")
        || name == QStringLiteral("H.265"))
        return VideoCodec::H265;
    if (name == QStringLiteral("h264") || name == QStringLiteral("H.264"))
        return VideoCodec::H264;
    return fallback;
}

QString exportContainerName(ExportContainer container)
{
    return container == ExportContainer::Mov ? QStringLiteral("mov") : QStringLiteral("mp4");
}

qint64 bitrateCapBps(int width, int height)
{
    const qint64 pixels = static_cast<qint64>(width) * static_cast<qint64>(height);
    if (pixels <= static_cast<qint64>(1920) * 1080)
        return 65000000;
    if (pixels <= static_cast<qint64>(3840) * 2160)
        return 100000000;
    return 130000000;
}

qint64 recommendedBitrateBps(int width, int height, double fps)
{
    // DogSC formula: pixels * fps / 6, clamped to [12 Mbps, cap].
    const double raw = static_cast<double>(width) * static_cast<double>(height) * fps / 6.0;
    const qint64 value = static_cast<qint64>(std::llround(raw));
    return std::clamp(value, static_cast<qint64>(12000000), bitrateCapBps(width, height));
}

bool ExportPreset::isValid(QString& error) const
{
    if (name.isEmpty()) {
        error = QStringLiteral("导出预设：缺少名称。");
        return false;
    }
    if (width < 16 || width > 7680 || height < 16 || height > 4320) {
        error = QStringLiteral("导出预设 %1：尺寸 %2x%3 超出 16..7680 / 16..4320。")
                    .arg(name).arg(width).arg(height);
        return false;
    }
    if ((width % 2) != 0 || (height % 2) != 0) {
        error = QStringLiteral("导出预设 %1：宽高必须是偶数（YUV420 编码要求），当前 %2x%3。")
                    .arg(name).arg(width).arg(height);
        return false;
    }
    if (fps < 1.0 || fps > 120.0) {
        error = QStringLiteral("导出预设 %1：帧率 %2 超出 1..120。").arg(name).arg(fps);
        return false;
    }
    if (tier == BitrateTier::Custom
        && (customBitrateBps < 1000000 || customBitrateBps > 200000000)) {
        error = QStringLiteral("导出预设 %1：自定义码率 %2 超出 1..200 Mbps。")
                    .arg(name).arg(customBitrateBps);
        return false;
    }
    if (audioBitrateBps < 32000 || audioBitrateBps > 512000) {
        error = QStringLiteral("导出预设 %1：音频码率 %2 超出 32..512 kbps。")
                    .arg(name).arg(audioBitrateBps);
        return false;
    }
    return true;
}

qint64 ExportPreset::bitrateBps() const
{
    const qint64 rec = recommendedBitrateBps(width, height, fps);
    const qint64 cap = bitrateCapBps(width, height);
    switch (tier) {
    case BitrateTier::Lower:
        return std::max(static_cast<qint64>(2000000), rec / 2);
    case BitrateTier::Higher:
        return std::min(cap, rec * 3 / 2);
    case BitrateTier::Custom:
        return std::clamp(customBitrateBps, static_cast<qint64>(1000000),
                          static_cast<qint64>(200000000));
    case BitrateTier::Recommended:
    default:
        return rec;
    }
}

QString ExportPreset::containerExtension() const
{
    return exportContainerName(container);
}

QJsonObject ExportPreset::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("width"), width);
    o.insert(QStringLiteral("height"), height);
    o.insert(QStringLiteral("fps"), fps);
    o.insert(QStringLiteral("codec"), videoCodecName(codec));
    o.insert(QStringLiteral("container"), exportContainerName(container));
    o.insert(QStringLiteral("tier"), static_cast<int>(tier));
    o.insert(QStringLiteral("customBitrateBps"), static_cast<qint64>(customBitrateBps));
    o.insert(QStringLiteral("audioBitrateBps"), audioBitrateBps);
    return o;
}

ExportPreset ExportPreset::fromJson(const QJsonObject& object, bool& ok)
{
    ExportPreset p;
    ok = object.contains(QStringLiteral("name"))
        && object.contains(QStringLiteral("width"))
        && object.contains(QStringLiteral("height"));
    if (!ok)
        return p;
    p.name = object.value(QStringLiteral("name")).toString();
    p.width = object.value(QStringLiteral("width")).toInt(1920);
    p.height = object.value(QStringLiteral("height")).toInt(1080);
    p.fps = object.value(QStringLiteral("fps")).toDouble(30.0);
    p.codec = videoCodecFromName(object.value(QStringLiteral("codec")).toString());
    p.container = object.value(QStringLiteral("container")).toString() == QStringLiteral("mov")
        ? ExportContainer::Mov : ExportContainer::Mp4;
    const int tier = object.value(QStringLiteral("tier")).toInt(1);
    p.tier = tier >= 0 && tier <= 3 ? static_cast<BitrateTier>(tier) : BitrateTier::Recommended;
    p.customBitrateBps = static_cast<qint64>(object.value(QStringLiteral("customBitrateBps")).toDouble(0.0));
    p.audioBitrateBps = object.value(QStringLiteral("audioBitrateBps")).toInt(192000);
    QString error;
    ok = p.isValid(error);
    return p;
}

QList<ExportPreset> builtinExportPresets()
{
    QList<ExportPreset> presets;
    struct Entry {
        const char* name;
        int w, h;
        VideoCodec codec;
    };
    const Entry entries[] = {
        {"1080p H.264", 1920, 1080, VideoCodec::H264},
        {"1080p H.265", 1920, 1080, VideoCodec::H265},
        {"4K H.264", 3840, 2160, VideoCodec::H264},
        {"4K H.265", 3840, 2160, VideoCodec::H265},
        {"8K H.264", 7680, 4320, VideoCodec::H264},
        {"8K H.265", 7680, 4320, VideoCodec::H265},
    };
    for (const Entry& e : entries) {
        ExportPreset p;
        p.name = QString::fromLatin1(e.name);
        p.width = e.w;
        p.height = e.h;
        p.fps = 30.0;
        p.codec = e.codec;
        p.container = ExportContainer::Mp4;
        p.tier = BitrateTier::Recommended;
        presets.append(p);
    }
    return presets;
}

const ExportPreset* findBuiltinPreset(const QString& name)
{
    static const QList<ExportPreset> presets = builtinExportPresets();
    for (const ExportPreset& p : presets) {
        if (p.name == name)
            return &p;
    }
    return nullptr;
}

} // namespace catcut
