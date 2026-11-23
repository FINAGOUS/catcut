// CatCut v2 — S3 export entry point (seed for S4).
//
// The export side of the one shared render path: re-evaluates the
// timeline at `timeSeconds` through TimelineEvaluator and renders
// through TimelineFrameRenderer — the same evaluator + renderer the
// preview uses (architecture doc hard rule 5) — decoding frames with
// Decoder directly, exactly as the S4 export pipeline will. There is
// no second compositing implementation: a preview frame and an export
// frame of the same timeline at the same time are the same pixels,
// which verify-s3 proves (mean error < 1%).

#pragma once

#include <QImage>
#include <QSize>
#include <QString>

namespace catcut {

class TimelineModel;

class ExportFrameRenderer {
public:
    // Renders one export frame at `timeSeconds` into `out` (canvas
    // `canvasSize`). Returns false with a readable `error` when any
    // video layer's frame cannot be decoded.
    static bool renderExportFrame(const TimelineModel* model, double timeSeconds,
                                  const QSize& canvasSize, QImage& out, QString& error);
};

} // namespace catcut
