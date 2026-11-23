// CatCut v2 — S4 export pipeline.
//
// The last link: timeline -> finished file. The video side reuses
// the one shared render path (TimelineEvaluator -> FrameScene ->
// TimelineFrameRenderer via ExportFrameRenderer, hard rule 5), so a
// preview frame and an export frame of the same timeline at the same
// time are the same pixels. Export ALWAYS re-links the original
// media: the renderer decodes Clip::mediaPath directly and this file
// never touches a proxy — proxies are preview-only (hard rule 4).
//
// Video encoding: hardware first (NVENC / QSV / AMF, probed in that
// order), falling back to software on open failure and recording the
// fallback. Software H.264 is libopenh264 (LGPL) then h264_mf.
// H.265 has no LGPL software encoder (libx265 is GPL): on a machine
// without a hardware HEVC encoder the H.265 presets fail with a
// readable error instead of silently changing codec.
// Audio: AAC 192 kbps (preset), mixed per Roles (AudioMix) and
// loudness-normalised to -16 LUFS (Loudness, loudnorm measure +
// linear gain). Stems are written as plain WAVs, one per role.
//
// Cancellation: ExportOptions::cancel is polled every frame; a
// cancelled export deletes its partial output file.

#pragma once

#include <QMap>
#include <QString>
#include <atomic>
#include <functional>

#include "core/AudioMix.h"
#include "core/ExportPreset.h"
#include "media/AudioDecoder.h"

namespace catcut {

class TimelineModel;

struct ExportOptions {
    RoleMixTable mix;              // per-role gain / pan / mute / solo
    bool loudnessNormalize = true; // normalise the mix to -16 LUFS
    bool writeSrtSidecar = true;   // write <output>.srt when subtitles exist
    // Progress: (framesDone, totalFrames). Called from the export thread.
    std::function<void(int, int)> progress;
    std::atomic<bool>* cancel = nullptr; // set true to cancel
};

struct ExportResult {
    bool ok = false;
    bool cancelled = false;
    QString error;
    QString outputPath;
    QString encoderName;     // e.g. "h264_nvenc", "libopenh264"
    bool hardwareEncoder = false;
    QString fallbackNote;    // why the encoder is not the first choice
    qint64 bitrateBps = 0;
    double durationSeconds = 0.0;
    double loudnessLUFS = 0.0; // NaN when the timeline has no audio
    bool hasAudio = false;
};

struct StemResult {
    bool ok = false;
    QString error;
    QMap<QString, QString> files;     // role -> wav path
    QMap<QString, double> durations;  // role -> seconds
};

class ExportPipeline {
public:
    // Exports `model` to `outputPath` (MP4/MOV per preset). The
    // output directory must exist. Returns a filled ExportResult.
    static ExportResult exportTimeline(const TimelineModel* model,
                                       const ExportPreset& preset,
                                       const QString& outputPath,
                                       const ExportOptions& options);

    // One WAV stem per role that has audible clips (roles from
    // TimelineModel::stemsByRole). Stems keep their mix balance
    // (no per-stem loudness normalisation). File names are
    // "<baseName>_<role>.wav" in `outputDir`.
    static StemResult exportStems(const TimelineModel* model,
                                  const QString& outputDir,
                                  const QString& baseName,
                                  const RoleMixTable& mix);

    // Encoder candidates for a codec, in try order (hardware first).
    static QStringList encoderCandidates(VideoCodec codec);
    static bool isHardwareEncoder(const QString& encoderName);

    // The full timeline mix at 48 kHz stereo float, per Roles + clip
    // volume/keyframes/fades. When `onlyRole` is non-empty, only that
    // role's clips are mixed. Empty when nothing audible is present.
    static DecodedAudio mixTimelineAudio(const TimelineModel* model,
                                         const RoleMixTable& mix,
                                         const QString& onlyRole = QString());

    // Writes 16-bit PCM WAV. Used for stems.
    static bool writeWav(const QString& path, const DecodedAudio& audio, QString& error);
};

} // namespace catcut
