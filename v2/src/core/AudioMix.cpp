#include "core/AudioMix.h"

#include <algorithm>
#include <cmath>

namespace catcut {

double dbToLinear(double db)
{
    return std::pow(10.0, db / 20.0);
}

double linearToDb(double linear)
{
    if (linear <= 0.0)
        return -120.0;
    return 20.0 * std::log10(linear);
}

bool RoleMix::isValid(QString& error) const
{
    if (gainDb < -60.0 || gainDb > 12.0) {
        error = QStringLiteral("角色混音：gain %1 dB 超出 -60..+12。").arg(gainDb);
        return false;
    }
    if (pan < -1.0 || pan > 1.0) {
        error = QStringLiteral("角色混音：pan %1 超出 -1..+1。").arg(pan);
        return false;
    }
    return true;
}

RoleMixTable::RoleMixTable() = default;

RoleMix RoleMixTable::mixFor(const QString& role) const
{
    return m_mix.value(role, RoleMix());
}

void RoleMixTable::setMix(const QString& role, const RoleMix& mix)
{
    if (!role.isEmpty())
        m_mix.insert(role, mix);
}

bool RoleMixTable::anySolo() const
{
    for (const RoleMix& mix : m_mix) {
        if (mix.solo)
            return true;
    }
    return false;
}

double RoleMixTable::effectiveGainLinear(const QString& role) const
{
    const RoleMix mix = mixFor(role);
    if (mix.mute)
        return 0.0;
    if (anySolo() && !mix.solo)
        return 0.0;
    return dbToLinear(mix.gainDb);
}

std::pair<double, double> RoleMixTable::panGains(const QString& role) const
{
    const double gain = effectiveGainLinear(role);
    const double pan = std::clamp(mixFor(role).pan, -1.0, 1.0);
    // Equal-power law: angle 0 (pan -1) -> L=1,R=0; angle pi/2 (pan +1)
    // -> L=0,R=1; centre -> 0.707 each.
    const double angle = (pan + 1.0) * 3.14159265358979323846 / 4.0;
    return {gain * std::cos(angle), gain * std::sin(angle)};
}

double fadeGain(double localTime, double clipDuration,
                double fadeInSeconds, double fadeOutSeconds)
{
    double gain = 1.0;
    if (fadeInSeconds > 0.0 && localTime < fadeInSeconds)
        gain = std::clamp(localTime / fadeInSeconds, 0.0, 1.0);
    if (fadeOutSeconds > 0.0) {
        const double timeToEnd = clipDuration - localTime;
        if (timeToEnd < fadeOutSeconds)
            gain = std::min(gain, std::clamp(timeToEnd / fadeOutSeconds, 0.0, 1.0));
    }
    return gain;
}

} // namespace catcut
