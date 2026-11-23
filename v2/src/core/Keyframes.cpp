#include "core/Keyframes.h"

#include <algorithm>
#include <cmath>

namespace catcut {

namespace {

// Cubic Bezier point at parameter u (0..1) for scalar control points.
double cubicBezier(double p0, double p1, double p2, double p3, double u)
{
    const double v = 1.0 - u;
    return v * v * v * p0 + 3.0 * v * v * u * p1 + 3.0 * v * u * u * p2
        + u * u * u * p3;
}

} // namespace

KeyframeTrack::KeyframeTrack(double defaultValue)
    : m_defaultValue(defaultValue)
{
}

void KeyframeTrack::addKeyframe(const Keyframe& keyframe)
{
    for (int i = 0; i < m_keyframes.size(); ++i) {
        if (std::fabs(m_keyframes[i].time - keyframe.time) < 1e-9) {
            m_keyframes[i] = keyframe;
            return;
        }
        if (m_keyframes[i].time > keyframe.time) {
            m_keyframes.insert(i, keyframe);
            return;
        }
    }
    m_keyframes.append(keyframe);
}

bool KeyframeTrack::removeKeyframeAt(double time)
{
    for (int i = 0; i < m_keyframes.size(); ++i) {
        if (std::fabs(m_keyframes[i].time - time) < 1e-9) {
            m_keyframes.removeAt(i);
            return true;
        }
    }
    return false;
}

bool KeyframeTrack::moveKeyframe(double oldTime, double newTime, double newValue)
{
    for (int i = 0; i < m_keyframes.size(); ++i) {
        if (std::fabs(m_keyframes[i].time - oldTime) < 1e-9) {
            Keyframe moved = m_keyframes[i];
            moved.time = newTime;
            moved.value = newValue;
            m_keyframes.removeAt(i);
            addKeyframe(moved);
            return true;
        }
    }
    return false;
}

void KeyframeTrack::clear()
{
    m_keyframes.clear();
}

double KeyframeTrack::valueAt(double t) const
{
    if (m_keyframes.isEmpty())
        return m_defaultValue;
    if (m_keyframes.size() == 1 || t <= m_keyframes.first().time)
        return m_keyframes.first().value;
    if (t >= m_keyframes.last().time)
        return m_keyframes.last().value;

    int seg = 0;
    for (int i = 0; i + 1 < m_keyframes.size(); ++i) {
        if (t >= m_keyframes[i].time && t <= m_keyframes[i + 1].time) {
            seg = i;
            break;
        }
    }
    const Keyframe& a = m_keyframes[seg];
    const Keyframe& b = m_keyframes[seg + 1];
    if (a.interpolation == KeyframeInterpolation::Hold)
        return a.value;

    const double span = b.time - a.time;
    if (span <= 0.0)
        return b.value;
    const double frac = (t - a.time) / span;
    if (a.interpolation == KeyframeInterpolation::Linear)
        return a.value + (b.value - a.value) * frac;

    // Bezier: control points clamped so the curve never folds back in
    // time (handles are offsets from their keyframes, limited to the
    // segment on both sides).
    const double c1x = std::clamp(a.time + a.outDx, a.time, b.time);
    const double c2x = std::clamp(b.time + b.inDx, a.time, b.time);
    const double c1y = a.value + a.outDy;
    const double c2y = b.value + b.inDy;
    // Solve x(u) = t by bisection (x(u) is monotonic once clamped).
    double lo = 0.0, hi = 1.0;
    for (int i = 0; i < 40; ++i) {
        const double mid = 0.5 * (lo + hi);
        const double x = cubicBezier(a.time, c1x, c2x, b.time, mid);
        if (x < t)
            lo = mid;
        else
            hi = mid;
    }
    const double u = 0.5 * (lo + hi);
    return cubicBezier(a.value, c1y, c2y, b.value, u);
}

KeyframeTrack& KeyframeSet::effectTrack(const QString& name, double defaultValue)
{
    auto it = effects.find(name);
    if (it == effects.end())
        it = effects.insert(name, KeyframeTrack(defaultValue));
    return it.value();
}

const KeyframeTrack* KeyframeSet::effectTrackOrNull(const QString& name) const
{
    auto it = effects.find(name);
    return it == effects.end() ? nullptr : &it.value();
}

double KeyframeSet::volumeAt(double t) const
{
    const KeyframeTrack* track = effectTrackOrNull(QStringLiteral("volume"));
    return track ? track->valueAt(t) : 1.0;
}

QMap<QString, double> KeyframeSet::valuesAt(double t) const
{
    QMap<QString, double> out;
    out.insert(QStringLiteral("x"), positionX.valueAt(t));
    out.insert(QStringLiteral("y"), positionY.valueAt(t));
    out.insert(QStringLiteral("scale"), scale.valueAt(t));
    out.insert(QStringLiteral("rotation"), rotation.valueAt(t));
    out.insert(QStringLiteral("opacity"), opacity.valueAt(t));
    return out;
}

} // namespace catcut
