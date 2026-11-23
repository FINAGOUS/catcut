#include "core/Transitions.h"

#include <algorithm>

namespace catcut {

double Transition::clampDuration(double seconds)
{
    if (!(seconds >= 0.0)) // NaN guard: a NaN duration becomes the default
        return kDefaultDuration;
    return std::clamp(seconds, kMinDuration, kMaxDuration);
}

QString transitionDisplayName(TransitionType type)
{
    switch (type) {
    case TransitionType::Dissolve: return QStringLiteral("叠化");
    case TransitionType::FlashWhite: return QStringLiteral("闪白");
    case TransitionType::FlashBlack: return QStringLiteral("闪黑");
    case TransitionType::Wipe: return QStringLiteral("推");
    case TransitionType::Slide: return QStringLiteral("滑入");
    }
    return QStringLiteral("叠化");
}

QString xfadeName(XfadeKind kind)
{
    switch (kind) {
    case XfadeKind::Fade: return QStringLiteral("fade");
    case XfadeKind::FadeWhite: return QStringLiteral("fadewhite");
    case XfadeKind::FadeBlack: return QStringLiteral("fadeblack");
    case XfadeKind::WipeLeft: return QStringLiteral("wipeleft");
    case XfadeKind::SlideLeft: return QStringLiteral("slideleft");
    case XfadeKind::SmoothLeft: return QStringLiteral("smoothleft");
    case XfadeKind::CircleOpen: return QStringLiteral("circleopen");
    case XfadeKind::Radial: return QStringLiteral("radial");
    }
    return QStringLiteral("fade");
}

QString xfadeName(TransitionType type)
{
    switch (type) {
    case TransitionType::Dissolve: return xfadeName(XfadeKind::Fade);
    case TransitionType::FlashWhite: return xfadeName(XfadeKind::FadeWhite);
    case TransitionType::FlashBlack: return xfadeName(XfadeKind::FadeBlack);
    case TransitionType::Wipe: return xfadeName(XfadeKind::WipeLeft);
    case TransitionType::Slide: return xfadeName(XfadeKind::SlideLeft);
    }
    return xfadeName(XfadeKind::Fade);
}

QList<QString> supportedXfadeNames()
{
    return { xfadeName(XfadeKind::Fade), xfadeName(XfadeKind::FadeWhite),
             xfadeName(XfadeKind::FadeBlack), xfadeName(XfadeKind::WipeLeft),
             xfadeName(XfadeKind::SlideLeft), xfadeName(XfadeKind::SmoothLeft),
             xfadeName(XfadeKind::CircleOpen), xfadeName(XfadeKind::Radial) };
}

QString buildXfadeFilter(const Transition& transition, double offsetSeconds)
{
    return QStringLiteral("xfade=transition=%1:duration=%2:offset=%3")
        .arg(xfadeName(transition.type))
        .arg(transition.duration, 0, 'f', 3)
        .arg(offsetSeconds, 0, 'f', 3);
}

QString buildAcrossfadeFilter(const Transition& transition)
{
    return QStringLiteral("acrossfade=d=%1").arg(transition.duration, 0, 'f', 3);
}

QList<TransitionType> demoTransitionTypes()
{
    return { TransitionType::Dissolve, TransitionType::FlashWhite,
             TransitionType::FlashBlack, TransitionType::Wipe,
             TransitionType::Slide };
}

} // namespace catcut
