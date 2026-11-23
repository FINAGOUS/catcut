// CatCut v2 — S2 timeline: keyframes.
//
// Position / scale / rotation / opacity / effect parameters can all be
// keyframed. Interpolation is linear, cubic-Bezier (with per-keyframe
// in/out handles, editable in the keyframe chart view — the curve
// editor CapCut's public docs do not describe, kept here as the
// differentiator) or hold. Times are seconds relative to the owning
// clip; values are plain doubles (position tracks are pairs of scalar
// tracks, x and y, so one evaluation path serves every parameter).

#pragma once

#include <QList>
#include <QMap>
#include <QString>

namespace catcut {

enum class KeyframeInterpolation {
    Linear, // straight line between this keyframe and the next
    Bezier, // cubic Bezier through the in/out handles
    Hold    // value stays until the next keyframe
};

struct Keyframe {
    double time = 0.0;   // seconds, relative to the owning clip
    double value = 0.0;
    // Bezier handles, as offsets from this keyframe (time, value).
    // out* belongs to the segment leaving this keyframe, in* to the
    // segment arriving at it. Clamped to the neighbouring keyframes by
    // KeyframeTrack::valueAt so the curve can never fold back in time.
    double outDx = 0.0;
    double outDy = 0.0;
    double inDx = 0.0;
    double inDy = 0.0;
    KeyframeInterpolation interpolation = KeyframeInterpolation::Linear;
};

// One animatable scalar parameter.
class KeyframeTrack {
public:
    explicit KeyframeTrack(double defaultValue = 0.0);

    double defaultValue() const { return m_defaultValue; }
    const QList<Keyframe>& keyframes() const { return m_keyframes; }
    bool isEmpty() const { return m_keyframes.isEmpty(); }
    int count() const { return m_keyframes.size(); }

    // Inserts (or replaces the keyframe at the same time, within 1e-9)
    // and keeps the list sorted by time.
    void addKeyframe(const Keyframe& keyframe);
    bool removeKeyframeAt(double time);
    // Moves the keyframe at `oldTime` to `newTime`/`newValue`.
    bool moveKeyframe(double oldTime, double newTime, double newValue);
    void clear();

    // Value at time `t` (seconds, relative to the clip). Before the
    // first keyframe: first value (or the default when empty). After
    // the last keyframe: last value. Inside a segment: the segment's
    // interpolation. Never throws, never NaN: out-of-range times clamp.
    double valueAt(double t) const;

private:
    double m_defaultValue;
    QList<Keyframe> m_keyframes;
};

// All keyframable parameters of one clip. Position is two scalar
// tracks (x, y) in normalised canvas coordinates (0..1, origin top
// left); scale is a multiplier (1 = 100%); rotation is degrees;
// opacity is 0..1. `effects` holds extra named parameters (e.g.
// "volume", S3 effect parameters) by name.
struct KeyframeSet {
    KeyframeTrack positionX{0.5};
    KeyframeTrack positionY{0.5};
    KeyframeTrack scale{1.0};
    KeyframeTrack rotation{0.0};
    KeyframeTrack opacity{1.0};

    QMap<QString, KeyframeTrack> effects;

    // Effect parameter track, created on demand with `defaultValue`.
    KeyframeTrack& effectTrack(const QString& name, double defaultValue = 0.0);
    const KeyframeTrack* effectTrackOrNull(const QString& name) const;

    double volumeAt(double t) const; // effect "volume", default 1.0

    QMap<QString, double> valuesAt(double t) const; // x/y/scale/rot/opacity
};

} // namespace catcut
