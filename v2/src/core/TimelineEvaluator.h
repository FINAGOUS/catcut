// CatCut v2 — S2 timeline: TimelineEvaluator.
//
// The single evaluation path (architecture doc section 4): a timeline
// is first evaluated at time `t` into one immutable FrameScene
// snapshot (geometry, visibility, transition mix progress, keyframe
// interpolation results) and only then handed to a renderer. Preview
// and S4 export share this evaluator — evaluation logic lives here,
// never in the UI.
//
// Transition semantics: a transition of duration d on the boundary
// (cut) between two primary clips occupies the centred window
// [cut - d/2, cut + d/2]. Inside the window both clips are active:
// the outgoing clip plays its tail past its normal end and the
// incoming clip plays its head before its normal start, so both need
// source handles. When a handle is missing (sourceIn == 0 /
// sourceOut == media end, which the model cannot know), the source
// time is clamped into [sourceIn, sourceOut] and
// FrameLayer::clampedToHandle is set so the UI/export can say so
// instead of silently showing a frozen frame.

#pragma once

#include <QList>
#include <QSize>
#include <QString>

#include "core/TimelineModel.h"

namespace catcut {

struct LayerGeometry {
    double x = 0.5;       // normalised canvas coords, origin top-left
    double y = 0.5;
    double scale = 1.0;   // multiplier, 1 = 100%
    double rotation = 0.0; // degrees, clockwise
    double opacity = 1.0; // 0..1
};

// One visible video/title layer of a single frame.
struct FrameLayer {
    QString clipId;
    QString mediaPath; // empty for title clips
    QString text;      // title text
    ClipKind kind = ClipKind::Video;
    QString role;
    int lane = 0;
    double sourceTime = 0.0; // seconds into the source media
    bool clampedToHandle = false; // sourceTime was clamped (see header)
    bool enabled = true;
    LayerGeometry geometry;

    // Transition participation (both false outside a transition).
    bool isTransitionOutgoing = false;
    bool isTransitionIncoming = false;
    TransitionType transitionType = TransitionType::Dissolve;
    double transitionProgress = 0.0; // 0..1 across the window
};

// One audible layer of a single frame (S4 mix uses this; the S2
// preview does not play audio).
struct FrameAudioLayer {
    QString clipId;
    QString role;
    double sourceTime = 0.0;
    double gain = 1.0; // clip.volume * volume keyframe
    bool enabled = true;
};

// Immutable snapshot of one frame. Renderers must not mutate it.
struct FrameScene {
    double time = 0.0;
    QSize canvas = QSize(1920, 1080);
    QList<FrameLayer> videoLayers; // bottom-to-top draw order
    QList<FrameAudioLayer> audioLayers;
    bool hasTransition = false;
    TransitionType transitionType = TransitionType::Dissolve;
    double transitionProgress = 0.0;
};

class TimelineEvaluator {
public:
    explicit TimelineEvaluator(const TimelineModel* model, QSize canvas = QSize(1920, 1080));

    FrameScene evaluate(double timeSeconds) const;

private:
    FrameLayer layerForClip(const Clip& clip, double timeSeconds,
                            bool outgoing, bool incoming,
                            const Transition* transition, double progress) const;

    const TimelineModel* m_model;
    QSize m_canvas;
};

} // namespace catcut
