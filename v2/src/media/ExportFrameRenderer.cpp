#include "media/ExportFrameRenderer.h"

#include "core/TimelineEvaluator.h"
#include "core/TimelineFrameRenderer.h"
#include "core/TimelineModel.h"
#include "media/Decoder.h"

namespace catcut {

bool ExportFrameRenderer::renderExportFrame(const TimelineModel* model, double timeSeconds,
                                            const QSize& canvasSize, QImage& out, QString& error)
{
    if (!model) {
        error = QStringLiteral("导出渲染：时间线为空。");
        return false;
    }
    TimelineEvaluator evaluator(model, canvasSize);
    const FrameScene scene = evaluator.evaluate(timeSeconds);
    TimelineFrameProvider provider = [canvasSize](const QString& path, double sourceTime,
                                                  QImage& frame) {
        QString decodeError;
        Decoder decoder;
        return decoder.decodeFrameAt(path, sourceTime, canvasSize, frame, decodeError);
    };
    return TimelineFrameRenderer::render(scene, provider, out, error, canvasSize, true);
}

} // namespace catcut
