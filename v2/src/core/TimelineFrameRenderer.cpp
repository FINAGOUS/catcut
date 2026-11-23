#include "core/TimelineFrameRenderer.h"

#include <QPainter>
#include <QPainterPath>
#include <QtMath>
#include <algorithm>
#include <cmath>

namespace catcut {

void TimelineFrameRenderer::drawLayer(QPainter* painter, const FrameLayer& layer,
                                      const QImage& frame, const QSize& canvasSize)
{
    const double w = canvasSize.width();
    const double h = canvasSize.height();
    painter->save();
    painter->setOpacity(std::clamp(layer.geometry.opacity, 0.0, 1.0));

    // Transition geometry: wipe reveals the incoming clip left->right,
    // slide pushes it in from the right. Dissolve/flash are opacity
    // only and are handled by the caller (see render()).
    if (layer.isTransitionIncoming && layer.transitionType == TransitionType::Wipe) {
        const int reveal = static_cast<int>(w * std::clamp(layer.transitionProgress, 0.0, 1.0));
        painter->setClipRect(0, 0, reveal, static_cast<int>(h));
    }
    if (layer.isTransitionIncoming && layer.transitionType == TransitionType::Slide) {
        const double offset = (1.0 - std::clamp(layer.transitionProgress, 0.0, 1.0)) * w;
        painter->translate(offset, 0.0);
    }

    // Geometry: position (normalised centre) + rotation + scale.
    painter->translate(w * layer.geometry.x, h * layer.geometry.y);
    painter->rotate(layer.geometry.rotation);
    const double scale = std::max(0.001, layer.geometry.scale);
    painter->scale(scale, scale);

    if (layer.kind == ClipKind::Title) {
        // Title: text centred on the layer's position.
        QFont font;
        font.setPixelSize(static_cast<int>(std::max(12.0, h * 0.06)));
        font.setBold(true);
        painter->setFont(font);
        painter->setPen(Qt::white);
        const QRectF rect(-w / 2.0, -h * 0.08, w, h * 0.16);
        painter->drawText(rect, Qt::AlignCenter, layer.text);
    } else if (!frame.isNull()) {
        // Fit the frame into the canvas keeping aspect ratio, then
        // draw it centred on the layer position.
        const double frameAspect = static_cast<double>(frame.width()) / frame.height();
        const double canvasAspect = w / h;
        double drawW = w, drawH = h;
        if (frameAspect > canvasAspect)
            drawH = w / frameAspect;
        else
            drawW = h * frameAspect;
        painter->drawImage(QRectF(-drawW / 2.0, -drawH / 2.0, drawW, drawH), frame);
    }
    painter->restore();
}

bool TimelineFrameRenderer::render(const FrameScene& scene,
                                   const TimelineFrameProvider& provider,
                                   QImage& out, QString& error,
                                   const QSize& canvasSize)
{
    const QSize size = canvasSize.isValid() ? canvasSize : scene.canvas;
    if (size.width() <= 0 || size.height() <= 0) {
        error = QStringLiteral("渲染画布尺寸无效。");
        return false;
    }
    QImage image(size, QImage::Format_RGBA8888);
    image.fill(Qt::black);
    QPainter painter(&image);
    painter.setRenderHint(QPainter::Antialiasing, true);
    painter.setRenderHint(QPainter::SmoothPixmapTransform, true);

    for (const FrameLayer& layer : scene.videoLayers) {
        if (layer.kind == ClipKind::Title) {
            drawLayer(&painter, layer, QImage(), size);
            continue;
        }
        QImage frame;
        if (!provider || !provider(layer.mediaPath, layer.sourceTime, frame)) {
            error = QStringLiteral("取不到片段画面（%1，源时间 %2s），渲染中止。")
                        .arg(layer.mediaPath)
                        .arg(layer.sourceTime, 0, 'f', 2);
            return false;
        }
        if (frame.isNull()) {
            error = QStringLiteral("解码出空画面（%1）。").arg(layer.mediaPath);
            return false;
        }
        // Dissolve: outgoing fades out, incoming fades in. The
        // evaluator already gave both layers; mix here, in the one
        // place that knows how a transition looks.
        FrameLayer mixed = layer;
        if (layer.isTransitionOutgoing && layer.transitionType == TransitionType::Dissolve)
            mixed.geometry.opacity *= (1.0 - std::clamp(layer.transitionProgress, 0.0, 1.0));
        else if (layer.isTransitionIncoming && layer.transitionType == TransitionType::Dissolve)
            mixed.geometry.opacity *= std::clamp(layer.transitionProgress, 0.0, 1.0);
        drawLayer(&painter, mixed, frame, size);
    }

    // Flash white / flash black: an overlay peaking mid-transition.
    if (scene.hasTransition
        && (scene.transitionType == TransitionType::FlashWhite
            || scene.transitionType == TransitionType::FlashBlack)) {
        const double peak = 1.0 - std::fabs(2.0 * scene.transitionProgress - 1.0);
        const QColor colour = scene.transitionType == TransitionType::FlashWhite
            ? Qt::white : Qt::black;
        painter.setOpacity(std::clamp(peak, 0.0, 1.0));
        painter.fillRect(QRect(QPoint(0, 0), size), colour);
        painter.setOpacity(1.0);
    }
    painter.end();
    out = image;
    return true;
}

} // namespace catcut
