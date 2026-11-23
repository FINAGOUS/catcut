// CatCut v2 — S4 self-test (verify-s4).
//
// Usage: verify-s4 <probe-dir> <output-dir>
//   probe-dir : test_4k.mp4 (video), test_tone.wav (48 kHz stereo
//               sine, generated in the workflow by ffmpeg lavfi)
//   output-dir: receives the export + stems + sidecar + renders.
//
// Checks (exit 0 = all passed):
//   1. export presets: bitrate formula (pixels*fps/6, clamped to
//      [12 Mbps, 65/100/130 Mbps caps]), tiers, validation, built-ins
//   2. Roles mix: gain/pan/mute/solo math, fades
//   3. SRT: parse/format round-trip, JSON round-trip, bad timecode
//   4. real export: 3 clips + 1 dissolve + grade -> MP4 1080p H.264
//      (software path on CI, no GPU); ffprobe-style checks via
//      MediaProbe (duration / resolution / codec / audio present)
//   5. preview-vs-export consistency: first frame of the exported
//      MP4 decoded back vs the preview render at t=0 — channel-mean
//      error < 1% of 255
//   6. stems: 2 roles -> 2 WAV files, durations match the timeline
//   7. loudness: the exported file measures near -16 LUFS (+-2)
//   8. subtitles: SRT sidecar written; a frame rendered with the
//      subtitle differs from the same frame without it in the
//      bottom band (burn-in through the shared renderer)
//   9. hooks: vocal separation + auto transcription report
//      honest errors (no fake stems / subtitles) and isAvailable()
//      is false
//  10. cancel: a pre-cancelled export fails fast, marks cancelled,
//      and leaves no output file
//
// Machine-readable lines for the run log:
//   EXPORT_ENCODER=<name>  EXPORT_HARDWARE=0|1
//   CONSISTENCY_MEAN_ERROR=<0..255>  LOUDNESS_MEASURED=<LUFS>

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QImage>
#include <QTextStream>
#include <QtMath>

#include <atomic>
#include <cmath>
#include <iostream>
#include <limits>

#include "core/AudioMix.h"
#include "core/ExportPreset.h"
#include "core/Roles.h"
#include "core/Subtitles.h"
#include "core/TimelineEvaluator.h"
#include "core/TimelineFrameRenderer.h"
#include "core/TimelineModel.h"
#include "media/AudioDecoder.h"
#include "media/AutoTranscription.h"
#include "media/Decoder.h"
#include "media/ExportFrameRenderer.h"
#include "media/ExportPipeline.h"
#include "media/Loudness.h"
#include "media/MediaProbe.h"
#include "media/PreviewRenderer.h"
#include "media/VocalSeparation.h"

namespace {

int g_failures = 0;

void check(bool ok, const QString& name, const QString& detail = QString())
{
    QTextStream out(stdout);
    if (ok) {
        out << "[PASS] " << name;
    } else {
        out << "[FAIL] " << name;
        ++g_failures;
    }
    if (!detail.isEmpty())
        out << " — " << detail;
    out << "\n";
    out.flush();
}

bool nearValue(double actual, double expected, double tolerance)
{
    return std::fabs(actual - expected) <= tolerance;
}

double imageMeanChannel(const QImage& img, int channel)
{
    const QImage rgba = img.format() == QImage::Format_RGBA8888
        ? img : img.convertToFormat(QImage::Format_RGBA8888);
    double sum = 0.0;
    const int n = rgba.width() * rgba.height();
    for (int y = 0; y < rgba.height(); ++y) {
        const uint8_t* row = rgba.constScanLine(y);
        for (int x = 0; x < rgba.width(); ++x)
            sum += row[x * 4 + channel];
    }
    return n ? sum / n : 0.0;
}

// Mean absolute difference over a horizontal band [y0, y1) of the frame.
double bandMeanAbsDiff(const QImage& a, const QImage& b, double y0Frac, double y1Frac)
{
    const QImage ra = a.format() == QImage::Format_RGBA8888
        ? a : a.convertToFormat(QImage::Format_RGBA8888);
    const QImage rb = b.format() == QImage::Format_RGBA8888
        ? b : b.convertToFormat(QImage::Format_RGBA8888);
    if (ra.size() != rb.size())
        return 1e9;
    const int y0 = static_cast<int>(ra.height() * y0Frac);
    const int y1 = static_cast<int>(ra.height() * y1Frac);
    double sum = 0.0;
    long n = 0;
    for (int y = y0; y < y1; ++y) {
        const uint8_t* rowA = ra.constScanLine(y);
        const uint8_t* rowB = rb.constScanLine(y);
        for (int x = 0; x < ra.width(); ++x) {
            for (int c = 0; c < 3; ++c) {
                sum += std::abs(static_cast<int>(rowA[x * 4 + c])
                                - static_cast<int>(rowB[x * 4 + c]));
                ++n;
            }
        }
    }
    return n ? sum / n : 0.0;
}

catcut::Clip makeVideoClip(const QString& name, const QString& path,
                           double sourceIn, double sourceOut)
{
    catcut::Clip clip;
    clip.name = name;
    clip.mediaPath = path;
    clip.kind = catcut::ClipKind::Video;
    clip.sourceIn = sourceIn;
    clip.sourceOut = sourceOut;
    return clip;
}

} // namespace

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);

    QTextStream out(stdout);
    out << "verify-s4: CatCut v2 S4 audio / subtitles / export self-test\n";
    out << "Qt: " << qVersion() << "\n";
    out.flush();

    if (argc < 3) {
        out << "usage: verify-s4 <probe-dir> <output-dir>\n";
        return 2;
    }
    const QDir probeDir(QString::fromLocal8Bit(argv[1]));
    const QDir outDir(QString::fromLocal8Bit(argv[2]));
    if (!outDir.exists())
        QDir().mkpath(outDir.absolutePath());
    const QString file4k = probeDir.filePath(QStringLiteral("test_4k.mp4"));
    const QString toneWav = probeDir.filePath(QStringLiteral("test_tone.wav"));
    check(QFileInfo::exists(file4k), "probe: test_4k.mp4 exists", file4k);
    check(QFileInfo::exists(toneWav), "probe: test_tone.wav exists", toneWav);

    // ------------------------------------------- 1. export presets
    {
        // DogSC formula: 1920x1080x30/6 = 10,368,000 -> 12 Mbps floor.
        check(catcut::recommendedBitrateBps(1920, 1080, 30.0) == 12000000,
              "preset: 1080p30 recommended bitrate clamps to the 12 Mbps floor",
              QString::number(catcut::recommendedBitrateBps(1920, 1080, 30.0)));
        // 3840x2160x30/6 = 41,472,000, under the 100 Mbps 4K cap.
        check(catcut::recommendedBitrateBps(3840, 2160, 30.0) == 41472000,
              "preset: 4K30 recommended bitrate is pixels*fps/6",
              QString::number(catcut::recommendedBitrateBps(3840, 2160, 30.0)));
        // 7680x4320x30/6 = 165,888,000 -> 130 Mbps 8K cap.
        check(catcut::recommendedBitrateBps(7680, 4320, 30.0) == 130000000,
              "preset: 8K30 recommended bitrate clamps to the 130 Mbps cap",
              QString::number(catcut::recommendedBitrateBps(7680, 4320, 30.0)));
        check(catcut::bitrateCapBps(1920, 1080) == 65000000, "preset: 1080p cap is 65 Mbps");
        check(catcut::bitrateCapBps(3840, 2160) == 100000000, "preset: 4K cap is 100 Mbps");

        catcut::ExportPreset p;
        p.name = QStringLiteral("1080p H.264");
        p.width = 1920;
        p.height = 1080;
        p.fps = 30.0;
        p.codec = catcut::VideoCodec::H264;
        p.tier = catcut::BitrateTier::Recommended;
        QString presetError;
        check(p.isValid(presetError), "preset: 1080p H.264 validates", presetError);
        check(p.bitrateBps() == 12000000, "preset: recommended tier resolves to 12 Mbps");
        p.tier = catcut::BitrateTier::Lower;
        check(p.bitrateBps() == 6000000, "preset: lower tier is half the recommended rate");
        p.tier = catcut::BitrateTier::Higher;
        check(p.bitrateBps() == 18000000, "preset: higher tier is 1.5x the recommended rate");
        p.tier = catcut::BitrateTier::Custom;
        p.customBitrateBps = 20000000;
        check(p.bitrateBps() == 20000000, "preset: custom tier uses the custom bitrate");
        p.tier = catcut::BitrateTier::Recommended;
        p.width = 1921;
        check(!p.isValid(presetError), "preset: odd width is rejected", presetError);
        p.width = 1920;
        p.fps = 0.0;
        check(!p.isValid(presetError), "preset: fps 0 is rejected", presetError);
        p.fps = 30.0;
        bool jsonOk = false;
        const catcut::ExportPreset roundTripped =
            catcut::ExportPreset::fromJson(p.toJson(), jsonOk);
        check(jsonOk && roundTripped.width == 1920 && roundTripped.fps == 30.0
                  && roundTripped.codec == catcut::VideoCodec::H264,
              "preset: JSON round-trip keeps size/fps/codec");
        check(catcut::builtinExportPresets().size() == 6,
              "preset: 6 built-ins (1080p/4K/8K x H.264/H.265)");
        check(catcut::findBuiltinPreset(QStringLiteral("4K H.265")) != nullptr,
              "preset: 4K H.265 built-in resolves");
        check(catcut::findBuiltinPreset(QStringLiteral("nope")) == nullptr,
              "preset: unknown built-in name resolves to null");
        // H.265 candidates are hardware-only in the LGPL build: the
        // list must contain no software encoder.
        const QStringList hevc = catcut::ExportPipeline::encoderCandidates(catcut::VideoCodec::H265);
        bool hevcSoftwareFree = true;
        for (const QString& e : hevc) {
            if (e == QStringLiteral("libx265"))
                hevcSoftwareFree = false;
        }
        check(hevcSoftwareFree && !hevc.isEmpty(),
              "preset: H.265 candidates are hardware-only (no libx265, GPL)",
              hevc.join(QStringLiteral(",")));
        check(catcut::ExportPipeline::isHardwareEncoder(QStringLiteral("h264_nvenc"))
                  && !catcut::ExportPipeline::isHardwareEncoder(QStringLiteral("libopenh264")),
              "preset: hardware encoder detection (nvenc yes, openh264 no)");
    }

    // ------------------------------------------------ 2. Roles mix
    {
        check(nearValue(catcut::dbToLinear(0.0), 1.0, 1e-9), "mix: 0 dB is unity gain");
        check(nearValue(catcut::dbToLinear(-20.0), 0.1, 1e-9), "mix: -20 dB is 0.1 linear");
        check(nearValue(catcut::dbToLinear(-60.0), 0.001, 1e-9), "mix: -60 dB is 0.001 linear");
        check(nearValue(catcut::kLoudnessTargetLUFS, -16.0, 1e-9),
              "mix: loudness target is -16 LUFS");

        catcut::RoleMixTable table;
        check(nearValue(table.effectiveGainLinear(catcut::RoleNames::kDialogue), 1.0, 1e-9),
              "mix: default role gain is unity");
        catcut::RoleMix dialogue;
        dialogue.gainDb = -6.0;
        dialogue.pan = -1.0; // hard left
        table.setMix(catcut::RoleNames::kDialogue, dialogue);
        const auto pan = table.panGains(catcut::RoleNames::kDialogue);
        check(nearValue(pan.first, catcut::dbToLinear(-6.0), 1e-9) && nearValue(pan.second, 0.0, 1e-9),
              "mix: pan -1 puts the role fully left",
              QString("L=%1 R=%2").arg(pan.first).arg(pan.second));
        const auto centre = table.panGains(catcut::RoleNames::kMusic);
        check(nearValue(centre.first, centre.second, 1e-9)
                  && nearValue(centre.first, 0.7071, 1e-3),
              "mix: centre pan is equal-power (0.707 each)");
        catcut::RoleMix music;
        music.solo = true;
        table.setMix(catcut::RoleNames::kMusic, music);
        check(table.anySolo(), "mix: solo is detected");
        check(nearValue(table.effectiveGainLinear(catcut::RoleNames::kDialogue), 0.0, 1e-9),
              "mix: a soloed role silences the others");
        check(nearValue(table.effectiveGainLinear(catcut::RoleNames::kMusic), 1.0, 1e-9),
              "mix: the soloed role itself stays audible");
        music.solo = false;
        music.mute = true;
        table.setMix(catcut::RoleNames::kMusic, music);
        check(nearValue(table.effectiveGainLinear(catcut::RoleNames::kMusic), 0.0, 1e-9),
              "mix: mute silences the role");
        check(nearValue(table.effectiveGainLinear(catcut::RoleNames::kDialogue),
                        catcut::dbToLinear(-6.0), 1e-9),
              "mix: unmuting the solo restores the other role");
        catcut::RoleMix bad;
        bad.gainDb = 13.0;
        QString mixError;
        check(!bad.isValid(mixError), "mix: gain +13 dB is out of the -60..+12 range", mixError);
        bad.gainDb = 0.0;
        bad.pan = 1.5;
        check(!bad.isValid(mixError), "mix: pan 1.5 is out of range", mixError);

        // Fades: linear ramps, 0 at the edge, 1 past the fade.
        check(nearValue(catcut::fadeGain(0.0, 4.0, 1.0, 1.0), 0.0, 1e-9),
              "mix: fade-in starts at 0");
        check(nearValue(catcut::fadeGain(0.5, 4.0, 1.0, 1.0), 0.5, 1e-9),
              "mix: fade-in is linear halfway");
        check(nearValue(catcut::fadeGain(2.0, 4.0, 1.0, 1.0), 1.0, 1e-9),
              "mix: fade gain is 1 mid-clip");
        check(nearValue(catcut::fadeGain(3.5, 4.0, 1.0, 1.0), 0.5, 1e-9),
              "mix: fade-out is linear halfway");
        check(nearValue(catcut::fadeGain(4.0, 4.0, 1.0, 1.0), 0.0, 1e-9),
              "mix: fade-out ends at 0");
        check(nearValue(catcut::fadeGain(0.0, 4.0, 0.0, 0.0), 1.0, 1e-9),
              "mix: no fades means gain 1 throughout");
    }

    // ------------------------------------------------------- 3. SRT
    catcut::SubtitleTrack track;
    {
        const QString srt = QStringLiteral(
            "1\n00:00:00,500 --> 00:00:02,500\n你好，世界\n\n"
            "2\n00:00:02,500 --> 00:00:03,000\n第二行字幕\n");
        QString parseError;
        check(catcut::SubtitleTrack::parseSrt(srt, track, parseError),
              "srt: parses a 2-item SRT", parseError);
        check(track.count() == 2, "srt: 2 items parsed");
        check(track.items()[0].text == QStringLiteral("你好，世界")
                  && nearValue(track.items()[0].start, 0.5, 1e-9)
                  && nearValue(track.items()[0].end, 2.5, 1e-9),
              "srt: first item text + times are right");
        check(track.indexAt(1.0) == 0 && track.indexAt(2.7) == 1 && track.indexAt(0.1) == -1,
              "srt: indexAt finds the active item");
        const QString reserialised = track.toSrt();
        catcut::SubtitleTrack reparsed;
        check(catcut::SubtitleTrack::parseSrt(reserialised, reparsed, parseError)
                  && reparsed.count() == 2
                  && reparsed.items()[1].text == QStringLiteral("第二行字幕"),
              "srt: format -> parse round-trips");
        check(catcut::SubtitleTrack::formatSrtTime(3661.234) == QStringLiteral("01:01:01,234"),
              "srt: timecode formats as HH:MM:SS,mmm");
        double parsedTime = 0.0;
        check(catcut::SubtitleTrack::parseSrtTime(QStringLiteral("01:01:01,234"), parsedTime)
                  && nearValue(parsedTime, 3661.234, 1e-9),
              "srt: timecode parses back");
        catcut::SubtitleTrack bad;
        check(!catcut::SubtitleTrack::parseSrt(
                  QStringLiteral("1\n99:99:99,999 --> 00:00:02,000\nxx\n"), bad, parseError)
                  || bad.count() == 0,
              "srt: a block with an unparseable timecode fails or is skipped", parseError);
        const catcut::SubtitleTrack jsonBack =
            catcut::SubtitleTrack::fromJson(track.toJson());
        check(jsonBack.count() == 2
                  && jsonBack.items()[0].text == QStringLiteral("你好，世界"),
              "srt: JSON round-trip keeps the items");
    }

    // --------------------------------------- 4-8. build the timeline
    // 3 video clips (1s each) + 1 dissolve + grade on clip A,
    // 2 audio clips (dialogue + music, same tone file, different
    // roles, with fades), 1 subtitle line.
    catcut::TimelineModel model;
    {
        model.appendPrimaryClip(makeVideoClip(QStringLiteral("A"), file4k, 0.0, 1.0));
        model.appendPrimaryClip(makeVideoClip(QStringLiteral("B"), file4k, 1.0, 2.0));
        model.appendPrimaryClip(makeVideoClip(QStringLiteral("C"), file4k, 2.0, 3.0));
        const QString aId = model.primaryClips()[0].id;
        catcut::Transition dissolve;
        dissolve.type = catcut::TransitionType::Dissolve;
        dissolve.setDuration(0.5);
        check(model.setTransition(aId, dissolve), "timeline: dissolve set after clip A");
        catcut::Clip* clipA = model.findClip(aId);
        clipA->gradeEnabled = true;
        clipA->grade.temperature = 0.3;

        catcut::Clip dialogue;
        dialogue.name = QStringLiteral("tone-dialogue");
        dialogue.mediaPath = toneWav;
        dialogue.kind = catcut::ClipKind::Audio;
        dialogue.role = catcut::RoleNames::kDialogue;
        dialogue.sourceIn = 0.0;
        dialogue.sourceOut = 3.0;
        dialogue.fadeInSeconds = 0.25;
        dialogue.fadeOutSeconds = 0.25;
        check(!model.addConnectedClip(dialogue, aId, 0.0, 0.0).isEmpty(),
              "timeline: dialogue audio clip connected to A");
        catcut::Clip music = dialogue;
        music.name = QStringLiteral("tone-music");
        music.role = catcut::RoleNames::kMusic;
        music.fadeInSeconds = 0.0;
        music.fadeOutSeconds = 0.0;
        check(!model.addConnectedClip(music, aId, 0.0, 0.0).isEmpty(),
              "timeline: music audio clip connected to A");
        check(nearValue(model.totalDuration(), 3.0, 1e-9),
              "timeline: total duration is 3s", QString::number(model.totalDuration()));
        check(model.stemsByRole().size() >= 2,
              "timeline: stemsByRole sees dialogue + music",
              QString::number(model.stemsByRole().size()));

        model.setSubtitles(track);
        // Evaluate at 1.5s: outside the dissolve window [0.75, 1.25],
        // so only clip B is active on the primary storyline (at 1.0s
        // both A-outgoing and B-incoming would be active: 4 layers).
        const catcut::TimelineEvaluator evaluator(&model, QSize(1920, 1080));
        const catcut::FrameScene scene = evaluator.evaluate(1.5);
        check(scene.hasSubtitle && scene.activeSubtitle == QStringLiteral("你好，世界"),
              "timeline: evaluator exposes the active subtitle at 1.5s");
        check(scene.audioLayers.size() == 3,
              "timeline: evaluator exposes 3 audio layers at 1.5s "
              "(primary clip B + dialogue + music)",
              QString::number(scene.audioLayers.size()));
        bool fadeSeen = false;
        for (const catcut::FrameAudioLayer& layer : scene.audioLayers) {
            if (layer.role == catcut::RoleNames::kDialogue
                && nearValue(layer.fadeInSeconds, 0.25, 1e-9))
                fadeSeen = true;
        }
        check(fadeSeen, "timeline: dialogue fade rides into the audio layer");
        // JSON round-trip keeps the S4 state (fades + subtitles).
        const QJsonObject json = model.toJson();
        catcut::TimelineModel restored;
        QString jsonError;
        check(restored.fromJson(json, jsonError), "timeline: JSON round-trip loads", jsonError);
        const catcut::Clip* restoredDialogue = nullptr;
        for (const catcut::Clip& c : restored.connectedClips()) {
            if (c.role == catcut::RoleNames::kDialogue)
                restoredDialogue = &c;
        }
        check(restoredDialogue && nearValue(restoredDialogue->fadeInSeconds, 0.25, 1e-9),
              "timeline: round-trip keeps the dialogue fade");
        check(restored.subtitles().count() == 2,
              "timeline: round-trip keeps the subtitle track");
    }

    // ------------------------------------------------ 4. real export
    const QString outputMp4 = outDir.filePath(QStringLiteral("s4-export.mp4"));
    catcut::ExportPreset preset;
    preset.name = QStringLiteral("1080p H.264");
    preset.width = 1920;
    preset.height = 1080;
    preset.fps = 12.0; // keeps the CI run fast; resolution is the 1080p check
    preset.codec = catcut::VideoCodec::H264;
    preset.container = catcut::ExportContainer::Mp4;
    preset.tier = catcut::BitrateTier::Recommended;

    catcut::ExportOptions options;
    options.loudnessNormalize = true;
    int progressCalls = 0;
    options.progress = [&progressCalls](int /*done*/, int /*total*/) { ++progressCalls; };
    const catcut::ExportResult result =
        catcut::ExportPipeline::exportTimeline(&model, preset, outputMp4, options);
    out << "EXPORT_ENCODER=" << result.encoderName << "\n";
    out << "EXPORT_HARDWARE=" << (result.hardwareEncoder ? 1 : 0) << "\n";
    out << "EXPORT_FALLBACK=" << result.fallbackNote << "\n";
    check(result.ok, "export: 3 clips + dissolve + grade exports to MP4", result.error);
    check(!result.encoderName.isEmpty(), "export: an encoder was chosen", result.encoderName);
    check(progressCalls > 0, "export: progress was reported",
          QString::number(progressCalls));
    check(QFileInfo::exists(outputMp4), "export: output file exists", outputMp4);
    double consistencyError = 1e9;
    double loudnessMeasured = std::numeric_limits<double>::quiet_NaN();
    if (result.ok) {
        const catcut::MediaInfo info = catcut::MediaProbe::probe(outputMp4);
        check(info.ok, "export: probe reads the output", info.error);
        check(nearValue(info.durationSeconds, 3.0, 0.6),
              "export: probe duration is ~3s", QString::number(info.durationSeconds));
        check(info.width == 1920 && info.height == 1080,
              "export: probe resolution is 1920x1080",
              QString("%1x%2").arg(info.width).arg(info.height));
        check(info.videoCodec == QStringLiteral("h264"),
              "export: probe video codec is h264", info.videoCodec);
        check(info.hasAudio, "export: probe finds an audio stream");

        // SRT sidecar next to the export.
        const QString sidecar = outputMp4 + QStringLiteral(".srt");
        check(QFileInfo::exists(sidecar), "export: SRT sidecar written next to the MP4");
        if (QFileInfo::exists(sidecar)) {
            QFile srtFile(sidecar);
            srtFile.open(QIODevice::ReadOnly | QIODevice::Text);
            const QString srtText = QString::fromUtf8(srtFile.readAll());
            catcut::SubtitleTrack reparsed;
            QString parseError;
            check(catcut::SubtitleTrack::parseSrt(srtText, reparsed, parseError)
                      && reparsed.count() == 2,
                  "export: sidecar SRT parses back to 2 items", parseError);
        }

        // -------------------------------- 5. preview-vs-export consistency
        {
            catcut::Decoder decoder;
            QImage decodedFirst;
            QString decodeError;
            const bool decoded = decoder.decodeFirstFrame(outputMp4, QSize(480, 270),
                                                          decodedFirst, decodeError);
            check(decoded, "consistency: exported MP4 decodes its first frame", decodeError);
            if (decoded) {
                QImage previewFrame;
                QString renderError;
                const bool rendered = catcut::ExportFrameRenderer::renderExportFrame(
                    &model, 0.0, QSize(480, 270), previewFrame, renderError);
                check(rendered, "consistency: preview render at t=0 works", renderError);
                if (rendered && decodedFirst.size() == previewFrame.size()) {
                    double meanDiff = 0.0;
                    for (int c = 0; c < 3; ++c)
                        meanDiff += std::fabs(imageMeanChannel(decodedFirst, c)
                                              - imageMeanChannel(previewFrame, c));
                    consistencyError = meanDiff / 3.0;
                    check(consistencyError < 2.55,
                          "consistency: decoded first frame vs preview, channel-mean error < 1%",
                          QString("mean error=%1 / 255").arg(consistencyError));
                    decodedFirst.save(outDir.filePath(QStringLiteral("s4-export-first.png")), "PNG");
                    previewFrame.save(outDir.filePath(QStringLiteral("s4-preview-first.png")), "PNG");
                }
            }
        }
        out << "CONSISTENCY_MEAN_ERROR=" << QString::number(consistencyError, 'f', 4) << "\n";

        // --------------------------------------- 7. loudness of the file
        {
            QString measureError;
            loudnessMeasured = catcut::Loudness::measureFile(outputMp4, measureError);
            out << "LOUDNESS_MEASURED=" << QString::number(loudnessMeasured, 'f', 2) << "\n";
            check(std::isfinite(loudnessMeasured),
                  "loudness: exported file measures a finite LUFS value", measureError);
            check(nearValue(loudnessMeasured, -16.0, 2.0),
                  "loudness: exported file is near the -16 LUFS target",
                  QString::number(loudnessMeasured, 'f', 2));
        }
    }

    // ---------------------------------------------------- 6. stems
    {
        const catcut::StemResult stems = catcut::ExportPipeline::exportStems(
            &model, outDir.absolutePath(), QStringLiteral("s4-stems"), catcut::RoleMixTable());
        check(stems.ok, "stems: per-role export succeeds", stems.error);
        check(stems.files.size() == 2, "stems: 2 roles -> 2 files",
              QString::number(stems.files.size()));
        for (auto it = stems.files.begin(); it != stems.files.end(); ++it) {
            const QString role = it.key();
            const QString path = it.value();
            check(QFileInfo::exists(path), "stems: stem file exists for role " + role, path);
            catcut::DecodedAudio audio;
            QString decodeError;
            const bool decoded = catcut::AudioDecoder::decodeAll(path, audio, decodeError);
            check(decoded, "stems: stem decodes for role " + role, decodeError);
            if (decoded) {
                check(nearValue(audio.durationSeconds(), 3.0, 0.3),
                      "stems: stem duration is ~3s for role " + role,
                      QString::number(audio.durationSeconds(), 'f', 2));
                check(!audio.isSilent(), "stems: stem is not silent for role " + role,
                      QString("rms=%1").arg(audio.rms()));
            }
            check(stems.durations.contains(role)
                      && nearValue(stems.durations[role], 3.0, 0.3),
                  "stems: reported duration is ~3s for role " + role);
        }
    }

    // ------------------------------------------- 8. subtitle burn-in
    {
        QImage withSubs, withoutSubs;
        QString renderError;
        const bool withOk = catcut::ExportFrameRenderer::renderExportFrame(
            &model, 1.0, QSize(480, 270), withSubs, renderError);
        check(withOk, "burn-in: frame with subtitle renders", renderError);
        catcut::TimelineModel noSubsModel = model;
        noSubsModel.setSubtitles(catcut::SubtitleTrack());
        const bool withoutOk = catcut::ExportFrameRenderer::renderExportFrame(
            &noSubsModel, 1.0, QSize(480, 270), withoutSubs, renderError);
        check(withoutOk, "burn-in: frame without subtitle renders (control)", renderError);
        if (withOk && withoutOk) {
            const double bandDiff = bandMeanAbsDiff(withSubs, withoutSubs, 0.80, 0.98);
            check(bandDiff > 0.5,
                  "burn-in: subtitle changes pixels in the bottom band",
                  QString("band mean abs diff=%1").arg(bandDiff));
            withSubs.save(outDir.filePath(QStringLiteral("s4-subtitle-burned.png")), "PNG");
            const int nonBlack =
                catcut::PreviewRenderer::countNonBlackPixels(withSubs, 16);
            check(nonBlack > (480 * 270) / 100,
                  "burn-in: subtitled frame is not black",
                  QString("non-black=%1").arg(nonBlack));
        }
    }

    // --------------------------------------------- 9. honest-error hooks
    {
        check(!catcut::VocalSeparator::isAvailable(),
              "hook: vocal separation reports no backend connected");
        QString vocals, accomp, sepError;
        const bool separated = catcut::VocalSeparator::separate(
            toneWav, outDir.absolutePath(), vocals, accomp, sepError);
        check(!separated && vocals.isEmpty() && accomp.isEmpty(),
              "hook: vocal separation fails without returning fake stems");
        check(sepError.contains(QStringLiteral("Demucs")),
              "hook: vocal separation error names Demucs + setup",
              sepError.left(60));
        check(!catcut::AutoTranscriber::isAvailable(),
              "hook: auto transcription reports no model connected");
        QList<catcut::SubtitleItem> items;
        QString transcribeError;
        const bool transcribed = catcut::AutoTranscriber::transcribe(
            toneWav, QStringLiteral("zh"), items, transcribeError);
        check(!transcribed && items.isEmpty(),
              "hook: auto transcription fails without returning fake subtitles");
        check(transcribeError.toLower().contains(QStringLiteral("whisper")),
              "hook: transcription error names whisper + setup",
              transcribeError.left(60));
    }

    // ------------------------------------------------------ 10. cancel
    {
        std::atomic<bool> cancelFlag(true); // cancelled before it starts
        catcut::ExportOptions cancelOptions;
        cancelOptions.cancel = &cancelFlag;
        const QString cancelledPath = outDir.filePath(QStringLiteral("s4-cancelled.mp4"));
        const catcut::ExportResult cancelled =
            catcut::ExportPipeline::exportTimeline(&model, preset, cancelledPath, cancelOptions);
        check(!cancelled.ok && cancelled.cancelled,
              "cancel: pre-cancelled export fails as cancelled", cancelled.error);
        check(!QFileInfo::exists(cancelledPath),
              "cancel: cancelled export leaves no output file");
    }

    // ---------------------------------------------------------- summary
    out << (g_failures == 0 ? "VERIFY-S4 RESULT: PASS\n"
                            : QStringLiteral("VERIFY-S4 RESULT: FAIL (%1 failures)\n").arg(g_failures));
    out.flush();
    return g_failures == 0 ? 0 : 1;
}
