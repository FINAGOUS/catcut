// CatCut v2 — S2 timeline: frame renderer for a FrameScene snapshot.
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
    static bool render(const FrameScene& scene, const TimelineFrameProvider& provider,
                       QImage& out, QString& error,
                       const QSize& canvasSize = QSize());

    // Draws one layer's frame (already decoded) onto `painter`, whose
    // target is the canvas. Exposed for tests.
    static void drawLayer(QPainter* painter, const FrameLayer& layer,
                          const QImage& frame, const QSize& canvasSize);
};

} // namespace catcut
