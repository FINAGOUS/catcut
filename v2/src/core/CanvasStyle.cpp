#include "core/CanvasStyle.h"

#include <QPainter>
#include <QPainterPath>
#include <algorithm>
#include <cmath>

namespace catcut {

namespace {

double clampd(double v, double lo, double hi) { return std::clamp(v, lo, hi); }

QJsonObject colourToJson(const QColor& c)
{
    QJsonObject o;
    o.insert(QStringLiteral("r"), c.red());
    o.insert(QStringLiteral("g"), c.green());
    o.insert(QStringLiteral("b"), c.blue());
    o.insert(QStringLiteral("a"), c.alpha());
    return o;
}

QColor colourFromJson(const QJsonObject& o, const QColor& fallback)
{
    if (!o.contains(QStringLiteral("r")))
        return fallback;
    return QColor(o.value(QStringLiteral("r")).toInt(fallback.red()),
                  o.value(QStringLiteral("g")).toInt(fallback.green()),
                  o.value(QStringLiteral("b")).toInt(fallback.blue()),
                  o.value(QStringLiteral("a")).toInt(fallback.alpha()));
}

} // namespace

QJsonObject NormalizedCrop::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("x"), x);
    o.insert(QStringLiteral("y"), y);
    o.insert(QStringLiteral("width"), width);
    o.insert(QStringLiteral("height"), height);
    return o;
}

NormalizedCrop NormalizedCrop::fromJson(const QJsonObject& o)
{
    NormalizedCrop c;
    c.x = clampd(o.value(QStringLiteral("x")).toDouble(0.0), 0.0, 1.0);
    c.y = clampd(o.value(QStringLiteral("y")).toDouble(0.0), 0.0, 1.0);
    c.width = clampd(o.value(QStringLiteral("width")).toDouble(1.0), 0.0, 1.0);
    c.height = clampd(o.value(QStringLiteral("height")).toDouble(1.0), 0.0, 1.0);
    if (c.width <= 0.0 || c.height <= 0.0) {
        c.x = 0.0;
        c.y = 0.0;
        c.width = 1.0;
        c.height = 1.0;
    }
    return c;
}

QString frameStyleName(FrameStyle style)
{
    switch (style) {
    case FrameStyle::WindowLight: return QStringLiteral("window-light");
    case FrameStyle::WindowDark: return QStringLiteral("window-dark");
    case FrameStyle::BrowserLight: return QStringLiteral("browser-light");
    case FrameStyle::BrowserDark: return QStringLiteral("browser-dark");
    case FrameStyle::Phone: return QStringLiteral("phone");
    case FrameStyle::Tablet: return QStringLiteral("tablet");
    case FrameStyle::None:
    default: return QStringLiteral("none");
    }
}

FrameStyle frameStyleFromName(const QString& name, FrameStyle fallback)
{
    if (name == QLatin1String("window-light")) return FrameStyle::WindowLight;
    if (name == QLatin1String("window-dark")) return FrameStyle::WindowDark;
    if (name == QLatin1String("browser-light")) return FrameStyle::BrowserLight;
    if (name == QLatin1String("browser-dark")) return FrameStyle::BrowserDark;
    if (name == QLatin1String("phone")) return FrameStyle::Phone;
    if (name == QLatin1String("tablet")) return FrameStyle::Tablet;
    if (name == QLatin1String("none")) return FrameStyle::None;
    // Unknown (retired/experimental) styles map to the nearest core
    // style instead of failing the load — DogSC does the same.
    if (name.contains(QLatin1String("browser"))) return FrameStyle::BrowserLight;
    if (name.contains(QLatin1String("window"))) return FrameStyle::WindowLight;
    if (name.contains(QLatin1String("phone"))) return FrameStyle::Phone;
    if (name.contains(QLatin1String("tablet"))) return FrameStyle::Tablet;
    return fallback;
}

bool CanvasStyle::isIdentity() const
{
    return crop.isIdentity() && padding == 0.0 && contentScale == 1.0
        && contentX == 0.5 && contentY == 0.5 && cornerRadius == 0.0
        && strokeWidth == 0.0 && shadowStrength == 0.0 && frame == FrameStyle::None;
}

FrameGeometry CanvasStyle::frameGeometry(const QSize& canvasSize) const
{
    FrameGeometry g;
    const double w = canvasSize.width(), h = canvasSize.height();
    const double pad = padding * std::min(w, h);
    g.outer = QRectF(pad, pad, w - 2 * pad, h - 2 * pad);
    g.content = g.outer;
    g.toolbar = QRectF();
    g.hasToolbar = false;
    g.contentColour = backgroundColour;
    g.title = frameTitle;
    const bool dark = frame == FrameStyle::WindowDark || frame == FrameStyle::BrowserDark;
    g.chromeColour = dark ? QColor(38, 38, 42) : QColor(236, 236, 238);
    switch (frame) {
    case FrameStyle::None:
        g.outerRadius = 0.0;
        g.innerRadius = 0.0;
        break;
    case FrameStyle::WindowLight:
    case FrameStyle::WindowDark: {
        const double barH = h * 0.045;
        g.toolbar = QRectF(g.outer.x(), g.outer.y(), g.outer.width(), barH);
        g.content = QRectF(g.outer.x(), g.outer.y() + barH, g.outer.width(),
                           g.outer.height() - barH);
        g.outerRadius = 10.0 * h / 1080.0;
        g.innerRadius = 6.0 * h / 1080.0;
        g.hasToolbar = true;
        break;
    }
    case FrameStyle::BrowserLight:
    case FrameStyle::BrowserDark: {
        const double barH = h * 0.075;
        g.toolbar = QRectF(g.outer.x(), g.outer.y(), g.outer.width(), barH);
        g.content = QRectF(g.outer.x(), g.outer.y() + barH, g.outer.width(),
                           g.outer.height() - barH);
        g.outerRadius = 10.0 * h / 1080.0;
        g.innerRadius = 6.0 * h / 1080.0;
        g.hasToolbar = true;
        break;
    }
    case FrameStyle::Phone: {
        // Portrait phone (or landscape when frameLandscape): a tall
        // rounded rect with a notch bar; content keeps its aspect.
        const double pw = frameLandscape ? w * 0.86 : w * 0.42;
        const double ph = frameLandscape ? h * 0.62 : h * 0.88;
        g.outer = QRectF((w - pw) / 2.0, (h - ph) / 2.0, pw, ph);
        const double bezel = 10.0 * h / 1080.0;
        g.content = g.outer.adjusted(bezel, bezel * 2.0, -bezel, -bezel);
        g.toolbar = QRectF(g.outer.x(), g.outer.y(), g.outer.width(), bezel * 2.0);
        g.outerRadius = 28.0 * h / 1080.0;
        g.innerRadius = 20.0 * h / 1080.0;
        g.hasToolbar = true;
        break;
    }
    case FrameStyle::Tablet: {
        const double pw = frameLandscape ? w * 0.88 : w * 0.62;
        const double ph = frameLandscape ? h * 0.66 : h * 0.86;
        g.outer = QRectF((w - pw) / 2.0, (h - ph) / 2.0, pw, ph);
        const double bezel = 12.0 * h / 1080.0;
        g.content = g.outer.adjusted(bezel, bezel, -bezel, -bezel);
        g.outerRadius = 18.0 * h / 1080.0;
        g.innerRadius = 12.0 * h / 1080.0;
        g.hasToolbar = false;
        break;
    }
    }
    return g;
}

void CanvasStyle::applyToImage(QImage& image) const
{
    if (image.isNull() || isIdentity())
        return;
    if (image.format() != QImage::Format_RGBA8888)
        image = image.convertToFormat(QImage::Format_RGBA8888);
    const int w = image.width(), h = image.height();
    const double scale = h / 1080.0;

    QImage out(w, h, QImage::Format_RGBA8888);
    out.fill(backgroundColour);
    QPainter p(&out);
    p.setRenderHint(QPainter::Antialiasing, true);
    p.setRenderHint(QPainter::SmoothPixmapTransform, true);

    // 1. Crop the source picture (normalised rect), then scale/position
    // it inside the frame content rect.
    const FrameGeometry geom = frameGeometry(QSize(w, h));
    const QRectF content = frame == FrameStyle::None
        ? QRectF(padding * std::min(w, h), padding * std::min(w, h),
                 w - 2 * padding * std::min(w, h), h - 2 * padding * std::min(w, h))
        : geom.content;
    const QRectF srcRect(crop.x * w, crop.y * h, crop.width * w, crop.height * h);
    // Fit the cropped picture into the content rect, then apply the
    // content scale + centre offset.
    const double fit = std::min(content.width() / std::max(1.0, srcRect.width()),
                                content.height() / std::max(1.0, srcRect.height()));
    const double drawW = srcRect.width() * fit * contentScale;
    const double drawH = srcRect.height() * fit * contentScale;
    const double cx = content.x() + content.width() * contentX;
    const double cy = content.y() + content.height() * contentY;
    const QRectF dstRect(cx - drawW / 2.0, cy - drawH / 2.0, drawW, drawH);

    // Shadow (behind the picture, offset down-right).
    if (shadowStrength > 0.0) {
        p.save();
        p.setOpacity(shadowStrength * 0.45);
        p.setBrush(Qt::black);
        p.setPen(Qt::NoPen);
        const double r = cornerRadius * scale;
        const double off = 10.0 * scale;
        p.drawRoundedRect(dstRect.adjusted(off, off, off, off), r, r);
        p.restore();
    }

    // Picture, clipped to the rounded corner radius.
    const double radius = cornerRadius * scale;
    if (radius > 0.0) {
        QPainterPath clip;
        clip.addRoundedRect(dstRect, radius, radius);
        p.setClipPath(clip);
    }
    p.drawImage(dstRect, image, srcRect);
    p.setClipping(false);

    // Stroke around the picture.
    if (strokeWidth > 0.0) {
        p.save();
        QColor stroke = strokeColour;
        stroke.setAlphaF(strokeOpacity);
        QPen pen(stroke, strokeWidth * scale);
        p.setPen(pen);
        p.setBrush(Qt::NoBrush);
        p.drawRoundedRect(dstRect, radius, radius);
        p.restore();
    }

    // Mockup frame chrome (geometry, not an image).
    if (frame != FrameStyle::None) {
        p.save();
        p.setBrush(geom.chromeColour);
        p.setPen(Qt::NoPen);
        p.drawRoundedRect(geom.outer, geom.outerRadius, geom.outerRadius);
        // Content area: re-draw the picture region is already done;
        // the chrome is the border + toolbar around it. Punch the
        // content rect back in by drawing the picture again clipped
        // to the inner rounded rect.
        QPainterPath innerClip;
        innerClip.addRoundedRect(geom.content, geom.innerRadius, geom.innerRadius);
        p.setClipPath(innerClip);
        p.drawImage(geom.content, image, srcRect);
        p.setClipping(false);
        if (geom.hasToolbar) {
            p.setBrush(geom.chromeColour.darker(108));
            p.drawRect(geom.toolbar);
            // Traffic-light dots for window/browser chrome.
            const double dot = 7.0 * scale;
            const double cy2 = geom.toolbar.center().y();
            const QColor dots[3] = {QColor(255, 95, 86), QColor(255, 189, 46), QColor(39, 201, 63)};
            for (int i = 0; i < 3; ++i) {
                p.setBrush(dots[i]);
                p.setPen(Qt::NoPen);
                p.drawEllipse(QPointF(geom.toolbar.x() + (16.0 + i * 18.0) * scale, cy2),
                              dot, dot);
            }
            p.setPen(geom.chromeColour.darker(160));
            QFont font;
            font.setPixelSize(static_cast<int>(std::max(10.0, 12.0 * scale)));
            p.setFont(font);
            p.drawText(geom.toolbar.adjusted(70 * scale, 0, -8, 0),
                       Qt::AlignVCenter | Qt::AlignLeft, geom.title);
        }
        p.restore();
    }
    p.end();
    image = out;
}

QJsonObject CanvasStyle::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("crop"), crop.toJson());
    o.insert(QStringLiteral("padding"), padding);
    o.insert(QStringLiteral("contentScale"), contentScale);
    o.insert(QStringLiteral("contentX"), contentX);
    o.insert(QStringLiteral("contentY"), contentY);
    o.insert(QStringLiteral("cornerRadius"), cornerRadius);
    o.insert(QStringLiteral("strokeWidth"), strokeWidth);
    o.insert(QStringLiteral("strokeColour"), colourToJson(strokeColour));
    o.insert(QStringLiteral("strokeOpacity"), strokeOpacity);
    o.insert(QStringLiteral("shadowStrength"), shadowStrength);
    o.insert(QStringLiteral("backgroundColour"), colourToJson(backgroundColour));
    o.insert(QStringLiteral("frame"), frameStyleName(frame));
    o.insert(QStringLiteral("frameLandscape"), frameLandscape);
    o.insert(QStringLiteral("frameTitle"), frameTitle);
    return o;
}

CanvasStyle CanvasStyle::fromJson(const QJsonObject& o)
{
    CanvasStyle s;
    s.crop = NormalizedCrop::fromJson(o.value(QStringLiteral("crop")).toObject());
    s.padding = clampd(o.value(QStringLiteral("padding")).toDouble(0.0), 0.0, 0.25);
    s.contentScale = clampd(o.value(QStringLiteral("contentScale")).toDouble(1.0), 0.1, 4.0);
    s.contentX = clampd(o.value(QStringLiteral("contentX")).toDouble(0.5), 0.0, 1.0);
    s.contentY = clampd(o.value(QStringLiteral("contentY")).toDouble(0.5), 0.0, 1.0);
    s.cornerRadius = clampd(o.value(QStringLiteral("cornerRadius")).toDouble(0.0), 0.0, 200.0);
    s.strokeWidth = clampd(o.value(QStringLiteral("strokeWidth")).toDouble(0.0), 0.0, 40.0);
    s.strokeColour = colourFromJson(o.value(QStringLiteral("strokeColour")).toObject(), Qt::white);
    s.strokeOpacity = clampd(o.value(QStringLiteral("strokeOpacity")).toDouble(1.0), 0.0, 1.0);
    s.shadowStrength = clampd(o.value(QStringLiteral("shadowStrength")).toDouble(0.0), 0.0, 1.0);
    s.backgroundColour = colourFromJson(o.value(QStringLiteral("backgroundColour")).toObject(), Qt::black);
    s.frame = frameStyleFromName(o.value(QStringLiteral("frame")).toString(QStringLiteral("none")));
    s.frameLandscape = o.value(QStringLiteral("frameLandscape")).toBool(false);
    s.frameTitle = o.value(QStringLiteral("frameTitle")).toString(QStringLiteral("CatCut"));
    return s;
}

} // namespace catcut
