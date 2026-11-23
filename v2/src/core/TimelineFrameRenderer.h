// CatCut v2 — S3 colour & picture: frame renderer for a FrameScene snapshot.
//
// This is the one compositing path: the UI preview and the S4 export
// both render through TimelineEvaluator -> FrameScene -> this
// renderer (architecture doc hard rule 5). The renderer only knows
// snapshots; it never touches the model or the UI.
//
// The `provider` supplies one decoded frame per layer: it is called
// with (mediaPath, sourceTimeSeconds) and must fill a QImage (any
// size; the renderer fits it to the canvas). In the app the provider
// is Decoder::decodeFrameAt; in tests it can be a stub. A provider
// failure fails the whole render with a readable error — a missing
// frame must never silently become a black frame.
//
// S3 per-layer picture pipeline (inside render(), per decoded frame):
//   chroma key -> beauty -> grade -> mosaic (primary layers only)
// The grade is the CPU reference implementation (ColorGrade); the
// live preview may instead render with applyGrade=false and let the
// PreviewWidget apply the same grade on the GPU (grade.frag) — see
// MainWindow::renderPreviewAtPlayhead. Either way the math and the
// order are the same; verify-s3 proves preview == export on the CPU
// path (mean error < 1%).
//
// Screen 3D tilt is approximated here as cosine foreshortening
// (affine only — QPainter cannot do a true perspective quad). The
// exact projected quad is CameraMotion::projectScreenQuad; the GPU
// preview path uses it. The difference is a documented S3 limitation.

#pragma once

#include <QImage>
#include <QSize>
#include <QString>
#include <functional>

#include "core/TimelineEvaluator.h"

class QPainter;

namespace catcut {

using TimelineFrameProvider =
    std::function<bool(const QString& mediaPath, double sourceTimeSeconds, QImage& out)>;

class TimelineFrameRenderer {
public:
    // Renders `scene` into an image of `canvasSize` (defaults to the
    // scene's own canvas). Returns false with a readable `error` when
    // any video layer's frame cannot be provided.
    // `applyGrade` = false renders the composite WITHOUT the per-clip
    // grade (the live GPU preview path: the PreviewWidget applies the
    // grade in its fragment shader instead). All other S3 effects
    // still apply. Defaults to true (export + CPU preview).
    static bool render(const FrameScene& scene, const TimelineFrameProvider& provider,
                       QImage& out, QString& error,
                       const QSize& canvasSize = QSize(), bool applyGrade = true);

    // Draws one layer's frame (already decoded) onto `painter`, whose
    // target is the canvas. Exposed for tests.
    static void drawLayer(QPainter* painter, const FrameLayer& layer,
                          const QImage& frame, const QSize& canvasSize);
};

} // namespace catcut
