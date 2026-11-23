#include "core/TimelineEvaluator.h"

#include <algorithm>
#include <cmath>

namespace catcut {

TimelineEvaluator::TimelineEvaluator(const TimelineModel* model, QSize canvas)
    : m_model(model)
    , m_canvas(canvas)
{
}

FrameLayer TimelineEvaluator::layerForClip(const Clip& clip, double timeSeconds,
                                           bool outgoing, bool incoming,
                                           const Transition* transition, double progress) const
{
    FrameLayer layer;
    layer.clipId = clip.id;
    layer.mediaPath = clip.mediaPath;
    layer.text = clip.text;
    layer.kind = clip.kind;
    layer.role = clip.role;
    layer.lane = m_model->laneIndexOf(clip.id);
    layer.enabled = clip.enabled;
    const double localTime = timeSeconds - clip.timelineStart;
    double sourceTime = clip.sourceIn + localTime;
    if (sourceTime < clip.sourceIn) {
        sourceTime = clip.sourceIn;
        layer.clampedToHandle = true;
    } else if (sourceTime > clip.sourceOut) {
        sourceTime = clip.sourceOut;
        layer.clampedToHandle = true;
    }
    layer.sourceTime = sourceTime;

    const QMap<QString, double> values = clip.keyframes.valuesAt(std::clamp(localTime, 0.0, clip.duration()));
    layer.geometry.x = values.value(QStringLiteral("x"), 0.5);
    layer.geometry.y = values.value(QStringLiteral("y"), 0.5);
    layer.geometry.scale = values.value(QStringLiteral("scale"), 1.0);
    layer.geometry.rotation = values.value(QStringLiteral("rotation"), 0.0);
    layer.geometry.opacity = values.value(QStringLiteral("opacity"), 1.0);

    layer.isTransitionOutgoing = outgoing;
    layer.isTransitionIncoming = incoming;
    if (transition) {
        layer.transitionType = transition->type;
        layer.transitionProgress = progress;
    }
    return layer;
}

FrameScene TimelineEvaluator::evaluate(double timeSeconds) const
{
    FrameScene scene;
    scene.time = timeSeconds;
    scene.canvas = m_canvas;
    if (!m_model)
        return scene;

    Transition transition;
    double progress = 0.0;
    QString leftId, rightId;
    const bool inTransition = m_model->transitionAt(timeSeconds, transition, progress, leftId, rightId);
    if (inTransition) {
        scene.hasTransition = true;
        scene.transitionType = transition.type;
        scene.transitionProgress = progress;
    }

    // --- primary storyline (transition overlap extends each clip's
    // active range by half the neighbouring transition) ---
    const QList<Clip>& primary = m_model->primaryClips();
    for (int i = 0; i < primary.size(); ++i) {
        const Clip& clip = primary[i];
        double activeStart = clip.timelineStart;
        double activeEnd = clip.timelineEnd();
        bool outgoing = false, incoming = false;
        if (inTransition) {
            if (clip.id == leftId) {
                activeEnd += transition.duration / 2.0;
                outgoing = true;
            } else if (clip.id == rightId) {
                activeStart -= transition.duration / 2.0;
                incoming = true;
            } else {
                continue;
            }
        }
        if (timeSeconds < activeStart - 1e-9 || timeSeconds >= activeEnd - 1e-9)
            continue;
        if (!clip.enabled)
            continue;
        FrameLayer layer = layerForClip(clip, timeSeconds, outgoing, incoming,
                                        inTransition ? &transition : nullptr, progress);
        if (layer.geometry.opacity <= 0.0)
            continue;
        scene.videoLayers.append(layer);
        if (clip.kind != ClipKind::Title) {
            FrameAudioLayer audio;
            audio.clipId = clip.id;
            audio.role = clip.role;
            audio.sourceTime = layer.sourceTime;
            audio.gain = clip.volume * clip.keyframes.volumeAt(
                std::clamp(timeSeconds - clip.timelineStart, 0.0, clip.duration()));
            audio.enabled = clip.enabled;
            scene.audioLayers.append(audio);
        }
    }

    // --- connected clips ---
    for (const Clip& clip : m_model->connectedClips()) {
        if (timeSeconds < clip.timelineStart - 1e-9
            || timeSeconds >= clip.timelineEnd() - 1e-9)
            continue;
        if (!clip.enabled)
            continue;
        FrameLayer layer = layerForClip(clip, timeSeconds, false, false, nullptr, 0.0);
        if (layer.geometry.opacity <= 0.0)
            continue;
        // Connected layers draw above the primary storyline, in lane order.
        scene.videoLayers.append(layer);
        if (clip.kind != ClipKind::Title) {
            FrameAudioLayer audio;
            audio.clipId = clip.id;
            audio.role = clip.role;
            audio.sourceTime = layer.sourceTime;
            audio.gain = clip.volume * clip.keyframes.volumeAt(
                std::clamp(timeSeconds - clip.timelineStart, 0.0, clip.duration()));
            audio.enabled = clip.enabled;
            scene.audioLayers.append(audio);
        }
    }

    // Draw order: primary first, then connected by lane (ascending).
    std::stable_sort(scene.videoLayers.begin(), scene.videoLayers.end(),
                     [](const FrameLayer& a, const FrameLayer& b) { return a.lane < b.lane; });
    return scene;
}

} // namespace catcut
