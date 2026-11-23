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

    // --- S3 per-clip picture effects ---
    layer.grade = clip.grade;
    layer.hasGrade = clip.gradeEnabled;
    layer.beauty = clip.beauty;
    layer.chromaKey = clip.chromaKey;
    layer.mask = clip.mask;
    layer.hasMask = clip.maskEnabled;
    return layer;
}

FrameScene TimelineEvaluator::evaluate(double timeSeconds) const
{
    FrameScene scene;
    scene.time = timeSeconds;
    scene.canvas = m_canvas;
    if (!m_model)
        return scene;

    // --- S3 project-level picture state at this time ---
    scene.canvasStyle = m_model->canvasStyle();
    for (const MosaicClip& mosaic : m_model->mosaics()) {
        if (mosaic.activeAt(timeSeconds)) {
            ActiveMosaic active;
            active.clip = mosaic;
            active.progress = mosaic.progressAt(timeSeconds);
            scene.activeMosaics.append(active);
        }
    }
    scene.autoZoom = m_model->autoZoomAt(timeSeconds, scene.autoZoomFocus);
    scene.screen3DPose = m_model->screen3DPoseAt(timeSeconds, scene.screen3DActive);
    scene.pointerVisible = m_model->pointerTrack().visibleAt(timeSeconds);
    scene.pointerSize = m_model->pointerTrack().size;
    if (scene.pointerVisible)
        m_model->pointerTrack().sampleAt(timeSeconds, scene.pointer);
    // Focus: 3D wins over zoom, never both (DogSC rule).
    const bool zoomFocusActive =
        m_model->zoomFocus().enabled && scene.autoZoom > 1.001;
    const bool screen3DFocusActive =
        m_model->screen3DFocus().enabled && scene.screen3DActive;
    scene.focusSource = resolveFocus(zoomFocusActive, screen3DFocusActive);
    if (scene.focusSource == FocusSource::Screen3D)
        scene.focusEffect = m_model->screen3DFocus();
    else if (scene.focusSource == FocusSource::Zoom)
        scene.focusEffect = m_model->zoomFocus();

    // --- S4 active subtitle at this time ---
    const SubtitleItem* subtitle = m_model->subtitles().itemAt(timeSeconds);
    if (subtitle) {
        scene.activeSubtitle = subtitle->text;
        scene.hasSubtitle = true;
    }

    Transition transition;
    double progress = 0.0;
    QString leftId, rightId;
    const bool inTransition = m_model->transitionAt(timeSeconds, transition, progress, leftId, rightId);
    if (inTransition) {
        scene.hasTransition = true;
        scene.transitionType = transition.type;
        scene.transitionProgress = progress;
    }

    auto fillSceneMotion = [&scene](FrameLayer& layer) {
        layer.sceneZoom = scene.autoZoom;
        layer.sceneZoomFocus = scene.autoZoomFocus;
        layer.scene3DPose = scene.screen3DPose;
        layer.scene3DActive = scene.screen3DActive;
    };

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
        layer.isPrimary = true;
        if (layer.geometry.opacity <= 0.0)
            continue;
        // S4: audio-only clips have no picture — they ride the audio
        // layers below, never the video layers (decoding a WAV as a
        // frame used to fail the whole render).
        if (clip.kind != ClipKind::Audio) {
            fillSceneMotion(layer);
            scene.videoLayers.append(layer);
        }
        if (clip.kind != ClipKind::Title) {
            FrameAudioLayer audio;
            audio.clipId = clip.id;
            audio.role = clip.role;
            audio.sourceTime = layer.sourceTime;
            audio.gain = clip.volume * clip.keyframes.volumeAt(
                std::clamp(timeSeconds - clip.timelineStart, 0.0, clip.duration()));
            audio.enabled = clip.enabled;
            audio.fadeInSeconds = clip.fadeInSeconds;
            audio.fadeOutSeconds = clip.fadeOutSeconds;
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
        layer.isPrimary = false;
        if (layer.geometry.opacity <= 0.0)
            continue;
        // S4: audio-only clips have no picture (see the primary loop).
        if (clip.kind != ClipKind::Audio) {
            fillSceneMotion(layer);
            // Connected layers draw above the primary storyline, in lane order.
            scene.videoLayers.append(layer);
        }
        if (clip.kind != ClipKind::Title) {
            FrameAudioLayer audio;
            audio.clipId = clip.id;
            audio.role = clip.role;
            audio.sourceTime = layer.sourceTime;
            audio.gain = clip.volume * clip.keyframes.volumeAt(
                std::clamp(timeSeconds - clip.timelineStart, 0.0, clip.duration()));
            audio.enabled = clip.enabled;
            audio.fadeInSeconds = clip.fadeInSeconds;
            audio.fadeOutSeconds = clip.fadeOutSeconds;
            scene.audioLayers.append(audio);
        }
    }

    // Draw order: primary first, then connected by lane (ascending).
    std::stable_sort(scene.videoLayers.begin(), scene.videoLayers.end(),
                     [](const FrameLayer& a, const FrameLayer& b) { return a.lane < b.lane; });
    return scene;
}

} // namespace catcut
