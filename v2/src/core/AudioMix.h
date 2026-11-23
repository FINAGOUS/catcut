// CatCut v2 — S4 Roles mix (FCP-style) + fades + loudness target.
//
// Roles mix: per-role gain (-60..+12 dB, FCP-style role trim), pan
// (-1 left .. +1 right, equal-power law), mute, solo. Solo wins over
// everything: when any role is soloed, every non-solo role is silent.
// Clip volume (Clip::volume * volume keyframes) is a separate, earlier
// trim and is applied by the mixer alongside the role gain.
//
// Loudness target is -16 LUFS (CatCut house target for spoken /
// short-video delivery; 剪映's is -12 — v2 deliberately differs and
// the target is written down here, not buried in a filter string).
// The target is enforced by ExportPipeline via Loudness (FFmpeg
// loudnorm measurement + a linear gain), never by clipping.

#pragma once

#include <QMap>
#include <QString>
#include <utility>

namespace catcut {

// House loudness target, LUFS (integrated). Written in the S4 doc too.
inline constexpr double kLoudnessTargetLUFS = -16.0;

double dbToLinear(double db);
double linearToDb(double linear); // -inf (<= -120) when linear <= 0

// Per-role mix settings. gainDb range -60..+12 (Roles range from the
// old TS engine spec audiofx.ts: Roles gain stays -60..+12 dB, while
// clip gain trim is -30..+30 dB — they are different trims).
struct RoleMix {
    double gainDb = 0.0; // -60..+12
    double pan = 0.0;    // -1 (left) .. +1 (right), 0 = centre
    bool mute = false;
    bool solo = false;

    bool isValid(QString& error) const;
};

class RoleMixTable {
public:
    RoleMixTable();

    // Mix for `role` (default-constructed when the role has no entry).
    RoleMix mixFor(const QString& role) const;
    void setMix(const QString& role, const RoleMix& mix);
    bool hasMix(const QString& role) const { return m_mix.contains(role); }

    bool anySolo() const;

    // Effective linear gain for a role (0 when muted, or when another
    // role is soloed and this one is not). Role gain only — clip
    // volume / keyframes / fades multiply on top.
    double effectiveGainLinear(const QString& role) const;

    // Equal-power pan law, including the role gain:
    //   pan -1 -> (1, 0), pan 0 -> (0.707, 0.707), pan +1 -> (0, 1).
    // Returns {left, right} linear multipliers.
    std::pair<double, double> panGains(const QString& role) const;

private:
    QMap<QString, RoleMix> m_mix;
};

// Fade gain (0..1) for a clip-local time: linear ramp in over
// fadeInSeconds, linear ramp out over fadeOutSeconds at the end.
// Zero durations mean "no fade on that side".
double fadeGain(double localTime, double clipDuration,
                double fadeInSeconds, double fadeOutSeconds);

} // namespace catcut
