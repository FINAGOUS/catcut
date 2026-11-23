// CatCut v2 — S6 self-test (verify-s6).
//
// Usage: verify-s6 <probe-dir> <output-dir>
//   probe-dir : test_4k.mp4 (video, generated in the workflow)
//   output-dir: receives the synthetic WAVs + the two exports.
//
// Checks (exit 0 = all passed):
//   1. denoise unit: AudioDenoise::applyAfftdn on a synthetic
//      tone (440 Hz, 0.5) + quiet white hiss (0.02) reduces the
//      8 kHz high-pass RMS — ratio < 0.93. The threshold is
//      measured, not guessed: the same signal gives ~0.77 on
//      FFmpeg 8.1 (CLI probe) and ~0.89 on FFmpeg 6.1 (C++
//      filter-graph probe), while loud broadband noise (~0.3) is
//      barely touched (~1.0) — which is why the test signal uses
//      QUIET hiss, the case afftdn is actually built for. Empty /
//      odd input fails with a readable error, never a crash.
//   2. denoise export: the same noisy timeline exported twice
//      (denoise off / on, loudness normalisation off so both
//      exports get the same gain), the denoised file's 8 kHz
//      high-pass RMS is lower — ratio < 0.97 (AAC adds a little
//      codec noise, hence the looser threshold than the unit
//      test). ExportResult::denoiseApplied is true only for
//      the denoised export.
//   3. export dialog: the denoise checkbox exists and defaults
//      to OFF (verify-s5 covers the rest of the dialog).
//   4. vocal separation (centre elimination, non-AI): a synthetic
//      stereo file — 1000 Hz "voice" at 0.4 identical in both
//      channels + 220 Hz left-only + 330 Hz right-only — separates
//      into a music track whose 1000 Hz component is < 10% of the
//      input while the 220/330 Hz instruments are kept (> 30%),
//      measured with Goertzel at each frequency. The centre file
//      keeps the voice (> 30% of input).
//   5. vocal separation refusals: mono input and a missing file
//      fail with readable errors (no fake stems, no silent music
//      track from a mono source).
//
// Machine-readable lines for the run log:
//   DENOISE_UNIT_RATIO=<0..1>  DENOISE_EXPORT_RATIO=<0..1>
//   VOCAL_VOICE_RATIO=<0..1>  VOCAL_INST220_KEPT=<0..1>
//   VOCAL_INST330_KEPT=<0..1>

#include <QApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QTextStream>
#include <QtMath>

#include <cmath>
#include <cstdint>
#include <iostream>

#include "core/AudioMix.h"
#include "core/ExportPreset.h"
#include "core/Roles.h"
#include "core/TimelineModel.h"
#include "media/AudioDecoder.h"
#include "media/AudioDenoise.h"
#include "media/ExportPipeline.h"
#include "media/VocalSeparation.h"
#include "ui/ExportDialog.h"

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

// Deterministic white noise (xorshift32): the test signal must be
// identical on every run, not rand() with an unknown seed.
struct XorShift {
    uint32_t state = 0x12345678u;
    double next()
    {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return (static_cast<double>(state) / 4294967296.0) * 2.0 - 1.0;
    }
};

// First-difference RMS of the (L+R)/2 mono mix: a high-pass measure
// that is dominated by hiss, not by a low-frequency tone. A 440 Hz
// tone contributes almost nothing to it (its per-sample change at
// 48 kHz is tiny), while white hiss dominates it.
double diffRms(const QVector<float>& samples)
{
    if (samples.size() < 4)
        return 0.0;
    const int frames = static_cast<int>(samples.size() / 2);
    double sum = 0.0;
    double prev = (samples[0] + samples[1]) * 0.5;
    for (int i = 1; i < frames; ++i) {
        const double cur = (samples[static_cast<qsizetype>(i) * 2]
                            + samples[static_cast<qsizetype>(i) * 2 + 1]) * 0.5;
        const double d = cur - prev;
        sum += d * d;
        prev = cur;
    }
    return std::sqrt(sum / (frames - 1));
}

// RMS of the (L+R)/2 mono mix through an RBJ high-pass biquad
// (fc = 8 kHz, Q = 0.7071, fs = 48 kHz): the 440 Hz tone is
// attenuated ~50 dB by it, so this is a pure hiss-band measure.
// Why not first-difference RMS: the tone dominates a differenced
// signal (tone diff-RMS 0.020 vs hiss 0.016), so even a perfect
// hiss cut only moves the ratio to ~0.92 — too tight to assert.
// The 8 kHz band isolates the hiss: measured ratio ~0.77 on
// FFmpeg 8.1 (CLI probe) and ~0.89 on FFmpeg 6.1 (C++ filter-graph
// probe, same signal), hence the 0.93 / 0.97 thresholds below.
double highpassRms(const QVector<float>& samples)
{
    if (samples.size() < 4)
        return 0.0;
    const double w0 = 2.0 * M_PI * 8000.0 / 48000.0;
    const double alpha = std::sin(w0) / (2.0 * 0.7071);
    const double cw = std::cos(w0);
    const double a0 = 1.0 + alpha;
    const double b0 = ((1.0 + cw) / 2.0) / a0;
    const double b1 = -(1.0 + cw) / a0;
    const double b2 = ((1.0 + cw) / 2.0) / a0;
    const double a1 = (-2.0 * cw) / a0;
    const double a2 = (1.0 - alpha) / a0;
    const int frames = static_cast<int>(samples.size() / 2);
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0, sum = 0.0;
    for (int i = 0; i < frames; ++i) {
        const double x = (samples[static_cast<qsizetype>(i) * 2]
                          + samples[static_cast<qsizetype>(i) * 2 + 1]) * 0.5;
        const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        sum += y * y;
    }
    return std::sqrt(sum / frames);
}

// Goertzel amplitude of one frequency in one channel of a stereo
// float buffer (channel 0 = left, 1 = right).
double goertzelAmplitude(const QVector<float>& samples, int channel, double freq,
                         double sampleRate)
{
    const int frames = static_cast<int>(samples.size() / 2);
    if (frames <= 0)
        return 0.0;
    const double k = std::round(frames * freq / sampleRate);
    const double w = 2.0 * M_PI * k / frames;
    const double coeff = 2.0 * std::cos(w);
    double s1 = 0.0, s2 = 0.0;
    for (int i = 0; i < frames; ++i) {
        const double v = samples[static_cast<qsizetype>(i) * 2 + channel];
        const double s0 = v + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const double power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    return std::sqrt(std::max(power, 0.0)) / frames * 2.0;
}

catcut::DecodedAudio makeNoisyTone(double seconds)
{
    const int frames = static_cast<int>(seconds * 48000);
    catcut::DecodedAudio audio;
    audio.sampleRate = 48000;
    audio.channels = 2;
    audio.samples.resize(frames * 2);
    XorShift rng;
    for (int i = 0; i < frames; ++i) {
        const double t = static_cast<double>(i) / 48000.0;
        const double tone = 0.5 * std::sin(2.0 * M_PI * 440.0 * t);
        const double hiss = 0.02 * rng.next();
        const float v = static_cast<float>(tone + hiss);
        audio.samples[static_cast<qsizetype>(i) * 2] = v;
        audio.samples[static_cast<qsizetype>(i) * 2 + 1] = v;
    }
    return audio;
}

catcut::DecodedAudio makeSeparationProbe(double seconds)
{
    const int frames = static_cast<int>(seconds * 48000);
    catcut::DecodedAudio audio;
    audio.sampleRate = 48000;
    audio.channels = 2;
    audio.samples.resize(frames * 2);
    for (int i = 0; i < frames; ++i) {
        const double t = static_cast<double>(i) / 48000.0;
        const double voice = 0.4 * std::sin(2.0 * M_PI * 1000.0 * t);
        const double instL = 0.4 * std::sin(2.0 * M_PI * 220.0 * t);
        const double instR = 0.4 * std::sin(2.0 * M_PI * 330.0 * t);
        audio.samples[static_cast<qsizetype>(i) * 2] = static_cast<float>(voice + instL);
        audio.samples[static_cast<qsizetype>(i) * 2 + 1] = static_cast<float>(voice + instR);
    }
    return audio;
}

} // namespace

int main(int argc, char* argv[])
{
    QApplication app(argc, argv);

    QTextStream out(stdout);
    out << "verify-s6: CatCut v2 S6 denoise + vocal separation self-test\n";
    out << "Qt: " << qVersion() << "\n";
    out.flush();

    if (argc < 3) {
        out << "usage: verify-s6 <probe-dir> <output-dir>\n";
        return 2;
    }
    const QDir probeDir(QString::fromLocal8Bit(argv[1]));
    const QDir outDir(QString::fromLocal8Bit(argv[2]));
    if (!outDir.exists())
        QDir().mkpath(outDir.absolutePath());
    const QString file4k = probeDir.filePath(QStringLiteral("test_4k.mp4"));
    check(QFileInfo::exists(file4k), "probe: test_4k.mp4 exists", file4k);

    // ------------------------------------------------- synthetic inputs
    const QString noisyWav = outDir.filePath(QStringLiteral("s6-noisy.wav"));
    const QString sepWav = outDir.filePath(QStringLiteral("s6-sep.wav"));
    const QString monoWav = outDir.filePath(QStringLiteral("s6-mono.wav"));
    {
        QString writeError;
        const catcut::DecodedAudio noisy = makeNoisyTone(3.0);
        check(catcut::ExportPipeline::writeWav(noisyWav, noisy, writeError),
              "probe: synthetic noisy tone WAV written", writeError);
        const catcut::DecodedAudio sep = makeSeparationProbe(4.0);
        check(catcut::ExportPipeline::writeWav(sepWav, sep, writeError),
              "probe: synthetic separation WAV written", writeError);
        catcut::DecodedAudio mono;
        mono.sampleRate = 48000;
        mono.channels = 1;
        const int frames = 2 * 48000;
        mono.samples.resize(frames);
        for (int i = 0; i < frames; ++i)
            mono.samples[i] = static_cast<float>(
                0.5 * std::sin(2.0 * M_PI * 440.0 * i / 48000.0));
        check(catcut::ExportPipeline::writeWav(monoWav, mono, writeError),
              "probe: synthetic mono WAV written", writeError);
    }

    // ------------------------------------------------- 1. denoise unit
    double unitRatio = 1e9;
    {
        check(catcut::AudioDenoise::isAvailable(),
              "denoise: afftdn filter is present in this FFmpeg build");
        QString emptyError;
        const QVector<float> emptyOut =
            catcut::AudioDenoise::applyAfftdn(QVector<float>(), emptyError);
        check(emptyOut.isEmpty() && !emptyError.isEmpty(),
              "denoise: empty input fails with a readable error, no crash", emptyError);
        QString oddError;
        const QVector<float> oddOut =
            catcut::AudioDenoise::applyAfftdn(QVector<float>{0.1f, 0.2f, 0.3f}, oddError);
        check(oddOut.isEmpty() && !oddError.isEmpty(),
              "denoise: odd-length input fails with a readable error", oddError);

        catcut::DecodedAudio noisy;
        QString decodeError;
        check(catcut::AudioDecoder::decodeAll(noisyWav, noisy, decodeError),
              "denoise: noisy probe decodes", decodeError);
        if (!noisy.samples.isEmpty()) {
            QString dnError;
            const QVector<float> denoised =
                catcut::AudioDenoise::applyAfftdn(noisy.samples, dnError);
            check(!denoised.isEmpty(), "denoise: afftdn returns samples", dnError);
            if (!denoised.isEmpty()) {
                check(denoised.size() == noisy.samples.size(),
                      "denoise: output length equals input length",
                      QString("%1 vs %2").arg(denoised.size()).arg(noisy.samples.size()));
                const double before = highpassRms(noisy.samples);
                const double after = highpassRms(denoised);
                unitRatio = before > 0.0 ? after / before : 1e9;
                out << "DENOISE_UNIT_RATIO=" << QString::number(unitRatio, 'f', 4) << "\n";
                out << "DENOISE_UNIT_HIGHPASS_RMS=" << QString::number(before, 'f', 6)
                    << " -> " << QString::number(after, 'f', 6) << "\n";
                check(unitRatio < 0.93,
                      "denoise: afftdn lowers the 8 kHz high-pass RMS of the noisy tone",
                      QString("ratio=%1 (threshold 0.93)").arg(unitRatio, 0, 'f', 4));
            }
        }
    }

    // ---------------------------------------------- 2. denoise export
    // One 3 s video clip + the noisy tone as a dialogue audio clip.
    // Loudness normalisation OFF for both exports so the two files
    // get the same gain and only the denoise differs.
    catcut::TimelineModel model;
    {
        catcut::Clip video;
        video.name = QStringLiteral("V");
        video.mediaPath = file4k;
        video.kind = catcut::ClipKind::Video;
        video.sourceIn = 0.0;
        video.sourceOut = 3.0;
        model.appendPrimaryClip(video);
        const QString vId = model.primaryClips()[0].id;
        catcut::Clip audio;
        audio.name = QStringLiteral("noisy-tone");
        audio.mediaPath = noisyWav;
        audio.kind = catcut::ClipKind::Audio;
        audio.role = catcut::RoleNames::kDialogue;
        audio.sourceIn = 0.0;
        audio.sourceOut = 3.0;
        check(!model.addConnectedClip(audio, vId, 0.0, 0.0).isEmpty(),
              "denoise-export: noisy audio clip connected");
        check(nearValue(model.totalDuration(), 3.0, 1e-9),
              "denoise-export: timeline is 3s", QString::number(model.totalDuration()));
    }
    catcut::ExportPreset preset;
    preset.name = QStringLiteral("1080p H.264");
    preset.width = 1920;
    preset.height = 1080;
    preset.fps = 12.0; // keeps the CI run fast, as in verify-s4
    preset.codec = catcut::VideoCodec::H264;
    preset.container = catcut::ExportContainer::Mp4;
    preset.tier = catcut::BitrateTier::Recommended;
    double exportRatio = 1e9;
    {
        catcut::ExportOptions plainOptions;
        plainOptions.loudnessNormalize = false;
        plainOptions.denoise = false;
        const QString plainMp4 = outDir.filePath(QStringLiteral("s6-export-plain.mp4"));
        const catcut::ExportResult plain =
            catcut::ExportPipeline::exportTimeline(&model, preset, plainMp4, plainOptions);
        check(plain.ok, "denoise-export: plain export succeeds", plain.error);
        check(!plain.denoiseApplied, "denoise-export: plain export reports denoise off");

        catcut::ExportOptions dnOptions;
        dnOptions.loudnessNormalize = false;
        dnOptions.denoise = true;
        const QString dnMp4 = outDir.filePath(QStringLiteral("s6-export-denoised.mp4"));
        const catcut::ExportResult denoised =
            catcut::ExportPipeline::exportTimeline(&model, preset, dnMp4, dnOptions);
        check(denoised.ok, "denoise-export: denoised export succeeds", denoised.error);
        check(denoised.denoiseApplied, "denoise-export: denoised export reports denoise on");
        check(denoised.fallbackNote.contains(QStringLiteral("afftdn")),
              "denoise-export: result note names afftdn", denoised.fallbackNote.left(80));

        if (plain.ok && denoised.ok) {
            catcut::DecodedAudio plainAudio, dnAudio;
            QString decodeError;
            const bool plainOk = catcut::AudioDecoder::decodeAll(plainMp4, plainAudio, decodeError);
            const bool dnOk = catcut::AudioDecoder::decodeAll(dnMp4, dnAudio, decodeError);
            check(plainOk && dnOk, "denoise-export: both exports decode audio", decodeError);
            if (plainOk && dnOk) {
                const double before = highpassRms(plainAudio.samples);
                const double after = highpassRms(dnAudio.samples);
                exportRatio = before > 0.0 ? after / before : 1e9;
                out << "DENOISE_EXPORT_RATIO=" << QString::number(exportRatio, 'f', 4) << "\n";
                out << "DENOISE_EXPORT_HIGHPASS_RMS=" << QString::number(before, 'f', 6)
                    << " -> " << QString::number(after, 'f', 6) << "\n";
                check(exportRatio < 0.97,
                      "denoise-export: denoised export has lower noise level than plain",
                      QString("ratio=%1 (threshold 0.97)").arg(exportRatio, 0, 'f', 4));
            }
        }
    }

    // --------------------------------------- 3. export dialog default
    {
        catcut::ExportDialog dialog(&model);
        check(!dialog.denoiseChecked(),
              "dialog: denoise checkbox defaults to OFF");
        check(catcut::ExportOptions().denoise == false,
              "dialog: ExportOptions::denoise defaults to false");
    }

    // ----------------------------------------- 4. vocal separation
    double voiceRatio = 1e9, kept220 = 0.0, kept330 = 0.0;
    {
        check(catcut::VocalSeparator::isAvailable(),
              "vocal: centre-elimination backend reports available");
        check(catcut::VocalSeparator::methodDescription().contains(QStringLiteral("非 AI")),
              "vocal: method is honestly labelled non-AI",
              catcut::VocalSeparator::methodDescription());
        QString vocalsPath, accompPath, sepError;
        const bool separated = catcut::VocalSeparator::separate(
            sepWav, outDir.absolutePath(), vocalsPath, accompPath, sepError);
        check(separated, "vocal: separation succeeds on the stereo probe", sepError);
        check(QFileInfo::exists(accompPath),
              "vocal: music track file exists", accompPath);
        check(QFileInfo::exists(vocalsPath),
              "vocal: centre file exists", vocalsPath);
        if (separated) {
            catcut::DecodedAudio input, music, centre;
            QString decodeError;
            const bool inOk = catcut::AudioDecoder::decodeAll(sepWav, input, decodeError);
            const bool musicOk = catcut::AudioDecoder::decodeAll(accompPath, music, decodeError);
            const bool centreOk = catcut::AudioDecoder::decodeAll(vocalsPath, centre, decodeError);
            check(inOk && musicOk && centreOk,
                  "vocal: input + both outputs decode", decodeError);
            if (inOk && musicOk && centreOk) {
                const double inVoice = goertzelAmplitude(input.samples, 0, 1000.0, 48000.0);
                const double outVoice = goertzelAmplitude(music.samples, 0, 1000.0, 48000.0);
                voiceRatio = inVoice > 0.0 ? outVoice / inVoice : 1e9;
                const double in220 = goertzelAmplitude(input.samples, 0, 220.0, 48000.0);
                const double out220 = goertzelAmplitude(music.samples, 0, 220.0, 48000.0);
                kept220 = in220 > 0.0 ? out220 / in220 : 0.0;
                const double in330 = goertzelAmplitude(input.samples, 1, 330.0, 48000.0);
                const double out330 = goertzelAmplitude(music.samples, 1, 330.0, 48000.0);
                kept330 = in330 > 0.0 ? out330 / in330 : 0.0;
                const double centreVoice = goertzelAmplitude(centre.samples, 0, 1000.0, 48000.0);
                const double centreVoiceRatio = inVoice > 0.0 ? centreVoice / inVoice : 0.0;
                out << "VOCAL_VOICE_RATIO=" << QString::number(voiceRatio, 'f', 4) << "\n";
                out << "VOCAL_INST220_KEPT=" << QString::number(kept220, 'f', 4) << "\n";
                out << "VOCAL_INST330_KEPT=" << QString::number(kept330, 'f', 4) << "\n";
                out << "VOCAL_CENTRE_VOICE_KEPT=" << QString::number(centreVoiceRatio, 'f', 4) << "\n";
                check(voiceRatio < 0.10,
                      "vocal: centred voice is cancelled out of the music track",
                      QString("1000 Hz ratio=%1 (threshold 0.10)").arg(voiceRatio, 0, 'f', 4));
                check(kept220 > 0.30,
                      "vocal: left instrument survives in the music track",
                      QString("220 Hz kept=%1 (threshold 0.30)").arg(kept220, 0, 'f', 4));
                check(kept330 > 0.30,
                      "vocal: right instrument survives in the music track",
                      QString("330 Hz kept=%1 (threshold 0.30)").arg(kept330, 0, 'f', 4));
                check(centreVoiceRatio > 0.30,
                      "vocal: centre file keeps the voice",
                      QString("centre 1000 Hz kept=%1 (threshold 0.30)")
                          .arg(centreVoiceRatio, 0, 'f', 4));
            }
        }
    }

    // ------------------------------------- 5. separation refusals
    {
        QString vocalsPath, accompPath, sepError;
        const bool monoOk = catcut::VocalSeparator::separate(
            monoWav, outDir.absolutePath(), vocalsPath, accompPath, sepError);
        check(!monoOk && vocalsPath.isEmpty() && accompPath.isEmpty(),
              "vocal: mono input fails without returning stems", sepError.left(80));
        check(sepError.contains(QStringLiteral("单声道")),
              "vocal: mono failure names the mono reason", sepError.left(80));
        QString missingVocals, missingAccomp, missingError;
        check(!catcut::VocalSeparator::separate(
                  outDir.filePath(QStringLiteral("does-not-exist.wav")),
                  outDir.absolutePath(), missingVocals, missingAccomp, missingError),
              "vocal: missing source fails with a readable error", missingError.left(80));
    }

    // ---------------------------------------------------------- summary
    out << (g_failures == 0 ? "VERIFY-S6 RESULT: PASS\n"
                            : QStringLiteral("VERIFY-S6 RESULT: FAIL (%1 failures)\n").arg(g_failures));
    out.flush();
    return g_failures == 0 ? 0 : 1;
}
