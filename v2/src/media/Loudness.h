// CatCut v2 — S4 loudness: FFmpeg loudnorm measurement + linear gain.
//
// House target is -16 LUFS (AudioMix::kLoudnessTargetLUFS). The flow
// is measure-then-gain, not a one-pass dynamic normaliser: the mixed
// audio is measured with the loudnorm filter in print mode, the gain
// (target - measured, clamped to +-30 dB) is applied as a single
// linear volume change, and the exported file is measured again by
// the self-test. Nothing is clipped and no dynamic range is eaten.

#pragma once

#include <QVector>
#include <QString>

namespace catcut {

class Loudness {
public:
    static constexpr double kTargetLUFS = -16.0;

    // Integrated loudness (LUFS) of interleaved stereo float 48 kHz
    // samples, measured by the libavfilter loudnorm filter. Returns
    // NaN and fills `error` when the measurement fails (e.g. empty
    // input or the filter is unavailable).
    static double measureIntegrated(const QVector<float>& samples, QString& error);

    // Convenience: decode a file with AudioDecoder, then measure it.
    static double measureFile(const QString& path, QString& error);

    // Linear gain (dB) to bring `measuredLUFS` to the target.
    // Clamped to [-30, +30] dB so a bad measurement can never blow
    // the mix out.
    static double gainToTarget(double measuredLUFS);

    // A copy of `samples` with the loudness gain applied. `measuredBefore`
    // is the pre-gain measurement, `appliedGainDb` the gain used.
    // Returns an empty vector + error when the measurement fails.
    static QVector<float> normalizeToTarget(const QVector<float>& samples,
                                            double& measuredBefore,
                                            double& appliedGainDb,
                                            QString& error);
};

} // namespace catcut
