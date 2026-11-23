// CatCut v2 — S4 export presets.
//
// 1080p/4K/8K x H.264/H.265, bitrate tiers (更低/推荐/更高/自定义).
// Recommended bitrate follows the DogSC formula from the research doc:
//   bitrate = pixels * fps / 6
// clamped to a 12 Mbps floor and a per-tier cap (65 Mbps at 1080p,
// 100 Mbps at 4K, 130 Mbps at 8K). H.265 has no LGPL software encoder
// (libx265 is GPL and never ships); H.265 presets encode through a
// hardware encoder when one exists and fail with a readable error
// otherwise — the preset itself is still valid, the failure is at
// encode time, reported by ExportPipeline.

#pragma once

#include <QJsonObject>
#include <QList>
#include <QString>

namespace catcut {

enum class VideoCodec {
    H264,
    H265
};

enum class ExportContainer {
    Mp4,
    Mov
};

enum class BitrateTier {
    Lower,      // 更低
    Recommended,// 推荐
    Higher,     // 更高
    Custom      // 自定义
};

QString videoCodecName(VideoCodec codec); // "h264" / "hevc"
VideoCodec videoCodecFromName(const QString& name, VideoCodec fallback = VideoCodec::H264);
QString exportContainerName(ExportContainer container); // "mp4" / "mov"

// Bitrate cap for a canvas size (DogSC tiers): 65 Mbps at <=1080p,
// 100 Mbps at <=4K, 130 Mbps above that (8K).
qint64 bitrateCapBps(int width, int height);

// Recommended bitrate: pixels * fps / 6, clamped to [12 Mbps, cap].
qint64 recommendedBitrateBps(int width, int height, double fps);

struct ExportPreset {
    QString name; // e.g. "1080p H.264 推荐"
    int width = 1920;
    int height = 1080;
    double fps = 30.0;
    VideoCodec codec = VideoCodec::H264;
    ExportContainer container = ExportContainer::Mp4;
    BitrateTier tier = BitrateTier::Recommended;
    qint64 customBitrateBps = 0; // only used when tier == Custom
    int audioBitrateBps = 192000; // AAC, DogSC default

    bool isValid(QString& error) const;
    // Resolved video bitrate for this preset (tier applied).
    qint64 bitrateBps() const;
    QString containerExtension() const; // "mp4" / "mov"

    QJsonObject toJson() const;
    static ExportPreset fromJson(const QJsonObject& object, bool& ok);
};

// Built-ins: 1080p/4K/8K x H.264/H.265, all at the Recommended tier.
QList<ExportPreset> builtinExportPresets();
const ExportPreset* findBuiltinPreset(const QString& name);

} // namespace catcut
