// CatCut v2 — S1 media pipeline: import probing.
//
// Reads container/codec/resolution/fps/duration/bit-depth/chroma/audio
// metadata the way ffprobe does, but never throws: any missing item is
// estimated, defaulted or reported as a readable error (hard rule 3:
// "外部库的任何一项元数据缺失都不许变成未处理异常").

#pragma once

#include <QString>

namespace catcut {

struct MediaInfo {
    bool ok = false;
    // Readable reason when !ok (e.g. file missing, corrupt header,
    // no decodable stream). Never a bare "格式不支持".
    QString error;
    // Non-fatal notes (e.g. "帧率未知", "时长未知"), kept even when ok.
    QString warning;

    QString container;        // short name, e.g. "mov,mp4,m4a,3gp,3g2,mj2"
    QString containerLongName;
    QString videoCodec;       // e.g. "h264", empty when no video stream
    QString videoCodecLongName;
    QString audioCodec;       // e.g. "aac", empty when no audio stream
    int width = 0;
    int height = 0;
    double fps = 0.0;         // 0 when unknown
    double durationSeconds = 0.0; // 0 when unknown
    int bitDepth = 0;         // 0 when unknown
    QString chroma;           // "4:2:0" / "4:2:2" / "4:4:4" / "4:1:1" / "" unknown
    QString pixFmt;           // e.g. "yuv420p10le", empty when unknown
    int audioChannels = 0;
    int audioSampleRate = 0;
    bool hasVideo = false;
    bool hasAudio = false;
};

class MediaProbe {
public:
    // Probes `path`. Never throws; check MediaInfo::ok and MediaInfo::error.
    static MediaInfo probe(const QString& path);

    // One-line human-readable summary, used by the UI media table.
    static QString describe(const MediaInfo& info);
};

} // namespace catcut
