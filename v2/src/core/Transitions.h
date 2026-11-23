// CatCut v2 — S2 timeline: transitions.
//
// Five transitions are implemented for the demo; the engine keeps an
// 8-way xfade extension port (see xfadeName / supportedXfadeNames) so
// S4 export can add the remaining three without touching the model.
// Video crossfades use FFmpeg `xfade`, audio uses `acrossfade` — the
// filter fragments here are the single source of truth for both the
// preview compositor (TimelineFrameRenderer interprets the same type +
// progress) and the S4 exporter.

#pragma once

#include <QList>
#include <QString>

namespace catcut {

enum class TransitionType {
    Dissolve,   // 叠化 (cross-dissolve)
    FlashWhite, // 闪白
    FlashBlack, // 闪黑
    Wipe,       // 推 (wipe left)
    Slide       // 滑入 (slide left)
};

// FFmpeg xfade names for the full 8-way extension port. The first five
// are the demo set; the last three are reserved for S4.
enum class XfadeKind {
    Fade,       // Dissolve
    FadeWhite,  // FlashWhite
    FadeBlack,  // FlashBlack
    WipeLeft,   // Wipe
    SlideLeft,  // Slide
    SmoothLeft, // reserved
    CircleOpen, // reserved
    Radial      // reserved
};

struct Transition {
    TransitionType type = TransitionType::Dissolve;
    // Seconds, clamped to [kMinDuration, kMaxDuration] by setDuration.
    double duration = kDefaultDuration;

    static constexpr double kDefaultDuration = 0.5;
    static constexpr double kMinDuration = 0.1;
    static constexpr double kMaxDuration = 5.0;

    static double clampDuration(double seconds);
    void setDuration(double seconds) { duration = clampDuration(seconds); }
    bool isValid() const { return duration >= kMinDuration && duration <= kMaxDuration; }
};

// Human-readable (Chinese) name, e.g. for the palette / inspector.
QString transitionDisplayName(TransitionType type);
// FFmpeg xfade filter name for a transition type ("fade", "fadewhite",
// "wipeleft", ...). The 8-way port: every XfadeKind has a name.
QString xfadeName(TransitionType type);
QString xfadeName(XfadeKind kind);
// All eight xfade names in port order.
QList<QString> supportedXfadeNames();
// `xfade=transition=<name>:duration=<d>:offset=<o>` fragment for S4.
// `offset` is the timeline time (seconds) where the transition starts.
QString buildXfadeFilter(const Transition& transition, double offsetSeconds);
// `acrossfade=d=<d>` fragment (audio side of the same transition).
QString buildAcrossfadeFilter(const Transition& transition);
// The five demo transitions, in palette order.
QList<TransitionType> demoTransitionTypes();

} // namespace catcut
