#include "core/TimelineFrameRenderer.h"

#include "core/BeautyKeying.h"

#include <QFont>
#include <QFontMetrics>
#include <QPainter>
#include <QPainterPath>
#include <QtMath>
#include <algorithm>
#include <cmath>

namespace catcut {

namespace {

// One box-blur pass (separated); the focus effect runs it H then V.
void boxBlurPass(QImage& image, int radius, bool horizontal)
{
    if (radius <= 0)
        return;
    const int w = image.width(), h = image.height();
    QImage src = image;
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            int accR = 0, accG = 0, accB = 0, n = 0;
            for (int d = -radius; d <= radius; ++d) {
                const int sx = horizontal ? std::clamp(x + d, 0, w - 1) : x;
                const int sy = horizontal ? y : std::clamp(y + d, 0, h - 1);
                const uint8_t* px = src.constScanLine(sy) + sx * 4;
                accR += px[0];
                accG += px[1];
                accB += px[2];
                ++n;
            }
            uint8_t* dst = image.scanLine(y) + x * 4;
            dst[0] = static_cast<uint8_t>(accR / n);
            dst[1] = static_cast<uint8_t>(accG / n);
            dst[2] = static_cast<uint8_t>(accB / n);
        }
    }
}

// Focus blur: sharp inside the focus ellipse, blurred + darkened
// outside, feathered between. Only ONE focus effect ever applies
// (the evaluator already resolved zoom-vs-3D).
void applyFocus(QImage& image, const FocusEffect& focus)
{
    if (!focus.enabled || focus.blur <= 0.0)
        return;
    QImage blurred = image;
    const int radius = std::max(1, static_cast<int>(focus.blur * 12.0));
    boxBlurPass(blurred, radius, true);
    boxBlurPass(blurred, radius, false);
    const int w = image.width(), h = image.height();
    const double cx = focus.centreX * w, cy = focus.centreY * h;
    const double rx = focus.size * w * 0.5, ry = focus.size * h * 0.5;
    const double feather = std::max(0.01, focus.feather * std::min(rx, ry));
    for (int y = 0; y < h; ++y) {
        uint8_t* row = image.scanLine(y);
        const uint8_t* brow = blurred.constScanLine(y);
        for (int x = 0; x < w; ++x) {
            const double ex = (x - cx) / std::max(1.0, rx);
            const double ey = (y - cy) / std::max(1.0, ry);
            const double e = std::sqrt(ex * ex + ey * ey);
            // k = 0 inside (sharp), 1 outside (blurred). Feather band
            // is [1-featherFrac, 1] in ellipse units.
            const double inner = 1.0 - focus.feather;
            double k = 0.0;
            if (e > inner)
                k = std::clamp((e - inner) / std::max(0.01, focus.feather), 0.0, 1.0);
            if (k <= 0.0)
                continue;
            uint8_t* px = row + x * 4;
            const uint8_t* bp = brow + x * 4;
            const double keep = 1.0 - focus.darken * k;
            for (int c = 0; c < 3; ++c)
                px[c] = static_cast<uint8_t>((px[c] * (1.0 - k) + bp[c] * k) * keep + 0.5);
        }
    }
}

} // namespace

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

    // S3 auto-zoom: zoom about the focus point, in canvas space.
    if (layer.sceneZoom != 1.0) {
        const double fx = layer.sceneZoomFocus.x() * w;
        const double fy = layer.sceneZoomFocus.y() * h;
        painter->translate(fx, fy);
        painter->scale(layer.sceneZoom, layer.sceneZoom);
        painter->translate(-fx, -fy);
    }

    // Geometry: position (normalised centre) + rotation + scale.
    painter->translate(w * layer.geometry.x, h * layer.geometry.y);
    painter->rotate(layer.geometry.rotation);
    const double scale = std::max(0.001, layer.geometry.scale);
    // S3 screen 3D (CPU approximation): Z rotation + size + tilt as
    // cosine foreshortening. Exact quad: projectScreenQuad().
    double sx = scale, sy = scale;
    if (layer.scene3DActive) {
        const Screen3D& pose = layer.scene3DPose;
        painter->rotate(pose.rotationZ);
        const double perspF = 1.0 - 0.1 * pose.perspective;
        sx *= pose.size * std::cos(pose.tiltY * M_PI / 180.0) * perspF;
        sy *= pose.size * std::cos(pose.tiltX * M_PI / 180.0) * perspF;
    }
    painter->scale(sx, sy);

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
                                   const QSize& canvasSize, bool applyGrade)
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
        // --- S3 per-layer picture pipeline: key -> mask -> beauty ->
        // grade -> mosaic (primary layers only; mosaics live in source
        // coordinates, so they are applied before the zoom/3D
        // transform in drawLayer and therefore follow the motion).
        if (frame.format() != QImage::Format_RGBA8888)
            frame = frame.convertToFormat(QImage::Format_RGBA8888);
        if (layer.chromaKey.enabled && !applyChromaKey(frame, layer.chromaKey)) {
            error = QStringLiteral("抠像失败（%1）。").arg(layer.mediaPath);
            return false;
        }
        if (layer.hasMask)
            applyMask(frame, layer.mask);
        if (layer.beauty.enabled)
            applyBeauty(frame, layer.beauty, nullptr);
        if (applyGrade && layer.hasGrade && !layer.grade.isIdentity())
            layer.grade.applyToImage(frame);
        if (layer.isPrimary) {
            for (const ActiveMosaic& m : scene.activeMosaics)
                applyMosaic(frame, m.clip, m.progress);
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

    // S3 focus blur (one effect only — resolved by the evaluator).
    if (scene.focusSource != FocusSource::None)
        applyFocus(image, scene.focusEffect);

    // S3 pointer track (drawn on top of the picture, under the canvas
    // chrome; a cursor already burned into imported video cannot be
    // hidden — this only draws the independent track).
    if (scene.pointerVisible) {
        QPainter pp(&image);
        pp.setRenderHint(QPainter::Antialiasing, true);
        const double px = scene.pointer.x * size.width();
        const double py = scene.pointer.y * size.height();
        const double s = 14.0 * scene.pointerSize * size.height() / 540.0;
        QPolygonF arrow;
        arrow << QPointF(px, py) << QPointF(px, py + s * 1.4)
              << QPointF(px + s * 0.45, py + s * 1.0) << QPointF(px + s * 0.7, py + s * 1.25)
              << QPointF(px + s * 0.95, py + s * 1.05) << QPointF(px + s * 0.7, py + s * 0.8)
              << QPointF(px + s * 1.0, py + s * 0.55);
        pp.setBrush(Qt::white);
        pp.setPen(QPen(Qt::black, 1.0));
        pp.drawPolygon(arrow);
        if (scene.pointer.clicked) {
            pp.setBrush(Qt::NoBrush);
            pp.setPen(QPen(QColor(255, 255, 255, 200), 2.0));
            pp.drawEllipse(QPointF(px + s * 0.4, py + s * 0.6), s * 0.9, s * 0.9);
        }
        pp.end();
    }

    // S4 subtitles: burn the active subtitle into the frame
    // (bottom-centre, white text on a translucent black box). This
    // runs in the one shared renderer, so preview and export burn
    // the identical pixels — the evaluator already resolved which
    // item is active at this time.
    if (scene.hasSubtitle && !scene.activeSubtitle.isEmpty()) {
        QPainter sp(&image);
        sp.setRenderHint(QPainter::Antialiasing, true);
        QFont font;
        font.setBold(true);
        font.setPixelSize(std::max(12, static_cast<int>(size.height() * 0.055)));
        sp.setFont(font);
        const QFontMetrics metrics(font);
        const QStringList lines = scene.activeSubtitle.split(QStringLiteral("\n"));
        int textWidth = 0;
        for (const QString& line : lines)
            textWidth = std::max(textWidth, metrics.horizontalAdvance(line));
        const int lineHeight = metrics.height();
        const int padX = size.width() / 64 + 8;
        const int padY = size.height() / 72 + 4;
        const int boxWidth = textWidth + padX * 2;
        const int boxHeight = lineHeight * lines.size() + padY * 2;
        const int boxX = (size.width() - boxWidth) / 2;
        const int boxY = size.height() - boxHeight - size.height() / 24;
        sp.setPen(Qt::NoPen);
        sp.setBrush(QColor(0, 0, 0, 160));
        sp.drawRoundedRect(boxX, boxY, boxWidth, boxHeight, 6, 6);
        sp.setPen(Qt::white);
        for (int i = 0; i < lines.size(); ++i) {
            const int lineWidth = metrics.horizontalAdvance(lines[i]);
            sp.drawText((size.width() - lineWidth) / 2,
                        boxY + padY + metrics.ascent() + i * lineHeight, lines[i]);
        }
        sp.end();
    }

    // S3 canvas composition (crop / padding / rounded corners /
    // stroke / shadow / mockup frame). No-op on an identity canvas.
    if (!scene.canvasStyle.isIdentity())
        scene.canvasStyle.applyToImage(image);

    out = image;
    return true;
}

} // namespace catcut
