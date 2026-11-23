#include "core/BeautyKeying.h"
#include <QJsonArray>

#include <algorithm>
#include <cmath>

namespace catcut {

namespace {

double clampd(double v, double lo, double hi) { return std::clamp(v, lo, hi); }

// One box-blur pass on RGBA8888 (radius in pixels). Separated: the
// caller runs it horizontally then vertically. Used as a cheap
// Gaussian approximation for beauty denoise (3 passes ~ Gaussian).
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
                int sx = horizontal ? std::clamp(x + d, 0, w - 1) : x;
                int sy = horizontal ? y : std::clamp(y + d, 0, h - 1);
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

double pointInPolygon(double nx, double ny, const QList<QPointF>& pts)
{
    // Ray casting; returns 1 inside, 0 outside.
    bool inside = false;
    const int n = pts.size();
    for (int i = 0, j = n - 1; i < n; j = i++) {
        const double xi = pts[i].x(), yi = pts[i].y();
        const double xj = pts[j].x(), yj = pts[j].y();
        if (((yi > ny) != (yj > ny))
            && (nx < (xj - xi) * (ny - yi) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside ? 1.0 : 0.0;
}

// Distance from a point to the rect edge, in normalised units
// (negative inside). Used for feathering rectangles/circles.
double rectEdgeDistance(double nx, double ny, double x, double y, double w, double h)
{
    const double dx = std::max({x - nx, 0.0, nx - (x + w)});
    const double dy = std::max({y - ny, 0.0, ny - (y + h)});
    const double outside = std::sqrt(dx * dx + dy * dy);
    if (outside > 0.0)
        return outside;
    const double inside = std::min({nx - x, x + w - nx, ny - y, y + h - ny});
    return -inside;
}

} // namespace

// ---------------------------------------------------------------- beauty

QJsonObject BeautySettings::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("enabled"), enabled);
    o.insert(QStringLiteral("strength"), strength);
    o.insert(QStringLiteral("brighten"), brighten);
    return o;
}

BeautySettings BeautySettings::fromJson(const QJsonObject& o)
{
    BeautySettings b;
    b.enabled = o.value(QStringLiteral("enabled")).toBool(false);
    b.strength = clampd(o.value(QStringLiteral("strength")).toDouble(0.5), 0.0, 1.0);
    b.brighten = clampd(o.value(QStringLiteral("brighten")).toDouble(0.05), 0.0, 0.2);
    return b;
}

void applyBeauty(QImage& image, const BeautySettings& settings, const QImage* mask)
{
    if (image.isNull() || !settings.enabled || settings.isIdentity())
        return;
    if (image.format() != QImage::Format_RGBA8888)
        image = image.convertToFormat(QImage::Format_RGBA8888);
    const bool useMask = mask && !mask->isNull() && mask->size() == image.size();
    QImage blurred = image;
    const int radius = 2; // small: beauty is a light denoise, not a blur
    boxBlurPass(blurred, radius, true);
    boxBlurPass(blurred, radius, false);
    boxBlurPass(blurred, radius, true);
    boxBlurPass(blurred, radius, false);
    const double strength = clampd(settings.strength, 0.0, 1.0);
    const double brighten = clampd(settings.brighten, 0.0, 0.2) * 255.0;
    for (int y = 0; y < image.height(); ++y) {
        uint8_t* row = image.scanLine(y);
        const uint8_t* brow = blurred.constScanLine(y);
        const uint8_t* mrow = useMask ? mask->constScanLine(y) : nullptr;
        for (int x = 0; x < image.width(); ++x) {
            uint8_t* px = row + x * 4;
            const uint8_t* bp = brow + x * 4;
            double m = 1.0;
            if (useMask) {
                // Red channel of the mask (grayscale masks store it there).
                m = mrow[x * (mask->format() == QImage::Format_Grayscale8 ? 1 : 4)] / 255.0;
            }
            const double k = strength * m;
            for (int c = 0; c < 3; ++c) {
                double v = px[c] * (1.0 - k) + bp[c] * k + brighten * m;
                px[c] = static_cast<uint8_t>(std::clamp(v, 0.0, 255.0) + 0.5);
            }
        }
    }
}

QString beautyKeyingConflict(const BeautySettings& beauty, bool portraitKeyingEnabled)
{
    if (beauty.enabled && beauty.strength > 0.0 && portraitKeyingEnabled) {
        return QStringLiteral(
            "美颜与人像抠像背景不能同时开启：两者都要用人像遮罩，会互相争夺背景。"
            "先关掉其中一个再继续。");
    }
    return QString();
}

// ---------------------------------------------------------------- chroma key

double ChromaKey::alphaFor(double r, double g, double b) const
{
    const double dr = r - keyR, dg = g - keyG, db = b - keyB;
    const double dist = std::sqrt(dr * dr + dg * dg + db * db) / std::sqrt(3.0);
    const double tol = clampd(tolerance, 0.0, 1.0);
    const double soft = std::max(0.001, clampd(softness, 0.0, 1.0));
    if (dist <= tol)
        return 0.0;
    if (dist >= tol + soft)
        return 1.0;
    return (dist - tol) / soft;
}

QJsonObject ChromaKey::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("enabled"), enabled);
    o.insert(QStringLiteral("keyR"), keyR);
    o.insert(QStringLiteral("keyG"), keyG);
    o.insert(QStringLiteral("keyB"), keyB);
    o.insert(QStringLiteral("tolerance"), tolerance);
    o.insert(QStringLiteral("softness"), softness);
    return o;
}

ChromaKey ChromaKey::fromJson(const QJsonObject& o)
{
    ChromaKey k;
    k.enabled = o.value(QStringLiteral("enabled")).toBool(false);
    k.keyR = clampd(o.value(QStringLiteral("keyR")).toDouble(0.0), 0.0, 1.0);
    k.keyG = clampd(o.value(QStringLiteral("keyG")).toDouble(1.0), 0.0, 1.0);
    k.keyB = clampd(o.value(QStringLiteral("keyB")).toDouble(0.0), 0.0, 1.0);
    k.tolerance = clampd(o.value(QStringLiteral("tolerance")).toDouble(0.25), 0.0, 1.0);
    k.softness = clampd(o.value(QStringLiteral("softness")).toDouble(0.10), 0.0, 1.0);
    return k;
}

bool applyChromaKey(QImage& image, const ChromaKey& key)
{
    if (image.isNull())
        return false;
    if (!key.enabled)
        return true;
    if (image.format() != QImage::Format_RGBA8888)
        image = image.convertToFormat(QImage::Format_RGBA8888);
    for (int y = 0; y < image.height(); ++y) {
        uint8_t* row = image.scanLine(y);
        for (int x = 0; x < image.width(); ++x) {
            uint8_t* px = row + x * 4;
            const double a = key.alphaFor(px[0] / 255.0, px[1] / 255.0, px[2] / 255.0);
            px[3] = static_cast<uint8_t>(a * 255.0 + 0.5);
        }
    }
    return true;
}

// ---------------------------------------------------------------- shape masks

double MaskShape::coverage(double nx, double ny) const
{
    double c = 0.0;
    switch (kind) {
    case MaskShapeKind::Rectangle: {
        const double d = rectEdgeDistance(nx, ny, x, y, width, height);
        c = d <= 0.0 ? 1.0 : 0.0;
        if (feather > 0.0) {
            const double f = feather * std::min(width, height);
            if (d > 0.0)
                c = std::max(0.0, 1.0 - d / f);
            else
                c = std::min(1.0, 1.0 + d / f); // d negative inside
        }
        break;
    }
    case MaskShapeKind::Circle: {
        const double cx = x + width / 2.0, cy = y + height / 2.0;
        const double rx = width / 2.0, ry = height / 2.0;
        const double ex = (nx - cx) / std::max(rx, 1e-6);
        const double ey = (ny - cy) / std::max(ry, 1e-6);
        const double e = std::sqrt(ex * ex + ey * ey);
        c = e <= 1.0 ? 1.0 : 0.0;
        if (feather > 0.0) {
            const double f = feather;
            c = clampd(1.0 - (e - 1.0 + f) / f, 0.0, 1.0);
        }
        break;
    }
    case MaskShapeKind::Polygon: {
        if (points.size() < 3)
            return 0.0;
        c = pointInPolygon(nx, ny, points);
        break;
    }
    }
    if (inverted)
        c = 1.0 - c;
    return clampd(c, 0.0, 1.0);
}

QJsonObject MaskShape::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("kind"), static_cast<int>(kind));
    o.insert(QStringLiteral("x"), x);
    o.insert(QStringLiteral("y"), y);
    o.insert(QStringLiteral("width"), width);
    o.insert(QStringLiteral("height"), height);
    QJsonArray pts;
    for (const QPointF& p : points) {
        QJsonObject po;
        po.insert(QStringLiteral("x"), p.x());
        po.insert(QStringLiteral("y"), p.y());
        pts.append(po);
    }
    o.insert(QStringLiteral("points"), pts);
    o.insert(QStringLiteral("feather"), feather);
    o.insert(QStringLiteral("inverted"), inverted);
    return o;
}

MaskShape MaskShape::fromJson(const QJsonObject& o)
{
    MaskShape m;
    m.kind = static_cast<MaskShapeKind>(o.value(QStringLiteral("kind")).toInt(0));
    if (m.kind != MaskShapeKind::Rectangle && m.kind != MaskShapeKind::Circle
        && m.kind != MaskShapeKind::Polygon)
        m.kind = MaskShapeKind::Rectangle;
    m.x = clampd(o.value(QStringLiteral("x")).toDouble(0.25), 0.0, 1.0);
    m.y = clampd(o.value(QStringLiteral("y")).toDouble(0.25), 0.0, 1.0);
    m.width = clampd(o.value(QStringLiteral("width")).toDouble(0.5), 0.0, 1.0);
    m.height = clampd(o.value(QStringLiteral("height")).toDouble(0.5), 0.0, 1.0);
    const QJsonArray pts = o.value(QStringLiteral("points")).toArray();
    for (const QJsonValue& v : pts) {
        const QJsonObject po = v.toObject();
        m.points.append(QPointF(clampd(po.value(QStringLiteral("x")).toDouble(0.0), 0.0, 1.0),
                                clampd(po.value(QStringLiteral("y")).toDouble(0.0), 0.0, 1.0)));
    }
    m.feather = clampd(o.value(QStringLiteral("feather")).toDouble(0.0), 0.0, 1.0);
    m.inverted = o.value(QStringLiteral("inverted")).toBool(false);
    return m;
}

void applyMask(QImage& image, const MaskShape& shape)
{
    if (image.isNull())
        return;
    if (image.format() != QImage::Format_RGBA8888)
        image = image.convertToFormat(QImage::Format_RGBA8888);
    const int w = image.width(), h = image.height();
    for (int y = 0; y < h; ++y) {
        uint8_t* row = image.scanLine(y);
        for (int x = 0; x < w; ++x) {
            const double c = shape.coverage((x + 0.5) / w, (y + 0.5) / h);
            uint8_t* px = row + x * 4;
            px[3] = static_cast<uint8_t>(px[3] * c + 0.5);
        }
    }
}

// ---------------------------------------------------------------- mosaic

double MosaicClip::progressAt(double t) const
{
    if (t < start || t >= end)
        return 0.0;
    double p = 1.0;
    if (fadeIn > 0.0 && t < start + fadeIn)
        p = std::min(p, (t - start) / fadeIn);
    if (fadeOut > 0.0 && t > end - fadeOut)
        p = std::min(p, (end - t) / fadeOut);
    return clampd(p, 0.0, 1.0);
}

QJsonObject MosaicClip::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("start"), start);
    o.insert(QStringLiteral("end"), end);
    o.insert(QStringLiteral("x"), x);
    o.insert(QStringLiteral("y"), y);
    o.insert(QStringLiteral("width"), width);
    o.insert(QStringLiteral("height"), height);
    o.insert(QStringLiteral("style"), static_cast<int>(style));
    o.insert(QStringLiteral("strength"), strength);
    o.insert(QStringLiteral("darken"), darken);
    o.insert(QStringLiteral("fadeIn"), fadeIn);
    o.insert(QStringLiteral("fadeOut"), fadeOut);
    o.insert(QStringLiteral("cornerRadius"), cornerRadius);
    return o;
}

MosaicClip MosaicClip::fromJson(const QJsonObject& o, bool& ok)
{
    MosaicClip m;
    ok = o.contains(QStringLiteral("id")) && o.contains(QStringLiteral("start"))
        && o.contains(QStringLiteral("end"));
    if (!ok)
        return m;
    m.id = o.value(QStringLiteral("id")).toString();
    m.start = o.value(QStringLiteral("start")).toDouble();
    m.end = o.value(QStringLiteral("end")).toDouble();
    m.x = clampd(o.value(QStringLiteral("x")).toDouble(0.25), 0.0, 1.0);
    m.y = clampd(o.value(QStringLiteral("y")).toDouble(0.25), 0.0, 1.0);
    m.width = clampd(o.value(QStringLiteral("width")).toDouble(0.5), 0.0, 1.0);
    m.height = clampd(o.value(QStringLiteral("height")).toDouble(0.5), 0.0, 1.0);
    m.style = static_cast<MosaicStyle>(o.value(QStringLiteral("style")).toInt(0));
    if (m.style != MosaicStyle::Blur && m.style != MosaicStyle::Spotlight)
        m.style = MosaicStyle::Blur;
    m.strength = clampd(o.value(QStringLiteral("strength")).toDouble(0.55), 0.0, 1.0);
    m.darken = clampd(o.value(QStringLiteral("darken")).toDouble(0.22), 0.0, 0.75);
    m.fadeIn = std::max(0.0, o.value(QStringLiteral("fadeIn")).toDouble(0.30));
    m.fadeOut = std::max(0.0, o.value(QStringLiteral("fadeOut")).toDouble(0.30));
    m.cornerRadius = clampd(o.value(QStringLiteral("cornerRadius")).toDouble(0.08), 0.0, 0.5);
    ok = m.end > m.start && !m.id.isEmpty();
    return m;
}

void applyMosaic(QImage& image, const MosaicClip& clip, double progress)
{
    if (image.isNull() || progress <= 0.0)
        return;
    if (image.format() != QImage::Format_RGBA8888)
        image = image.convertToFormat(QImage::Format_RGBA8888);
    const int w = image.width(), h = image.height();
    const int rx0 = static_cast<int>(clip.x * w);
    const int ry0 = static_cast<int>(clip.y * h);
    const int rx1 = static_cast<int>((clip.x + clip.width) * w);
    const int ry1 = static_cast<int>((clip.y + clip.height) * h);
    const double strength = clampd(clip.strength, 0.0, 1.0) * clampd(progress, 0.0, 1.0);
    if (clip.style == MosaicStyle::Blur) {
        QImage blurred = image;
        const int radius = std::max(1, static_cast<int>(8 * strength));
        boxBlurPass(blurred, radius, true);
        boxBlurPass(blurred, radius, false);
        // Rounded-rect coverage (radius normalised by the short edge,
        // DogSC semantics): blend blurred inside, original outside.
        const double shortEdge = std::min(clip.width * w, clip.height * h);
        const double corner = clip.cornerRadius * shortEdge;
        for (int y = ry0; y < ry1 && y < h; ++y) {
            uint8_t* row = image.scanLine(y);
            const uint8_t* brow = blurred.constScanLine(y);
            for (int x = rx0; x < rx1 && x < w; ++x) {
                // Cheap rounded-corner test: shrink coverage near corners.
                double cov = 1.0;
                const double dx = std::min(x - rx0, rx1 - 1 - x);
                const double dy = std::min(y - ry0, ry1 - 1 - y);
                if (corner > 0.0 && dx < corner && dy < corner) {
                    const double ex = corner - dx, ey = corner - dy;
                    const double dist = std::sqrt(ex * ex + ey * ey);
                    cov = dist >= corner ? 0.0 : 1.0;
                }
                const double k = strength * cov;
                uint8_t* px = row + x * 4;
                const uint8_t* bp = brow + x * 4;
                for (int c = 0; c < 3; ++c)
                    px[c] = static_cast<uint8_t>(px[c] * (1.0 - k) + bp[c] * k + 0.5);
            }
        }
    } else {
        // Spotlight: darken everything outside the rect, keep inside crisp.
        const double darken = clampd(clip.darken, 0.0, 0.75) * strength;
        const double keep = 1.0 - darken;
        for (int y = 0; y < h; ++y) {
            uint8_t* row = image.scanLine(y);
            const bool insideY = y >= ry0 && y < ry1;
            for (int x = 0; x < w; ++x) {
                if (insideY && x >= rx0 && x < rx1)
                    continue;
                uint8_t* px = row + x * 4;
                for (int c = 0; c < 3; ++c)
                    px[c] = static_cast<uint8_t>(px[c] * keep + 0.5);
            }
        }
    }
}

} // namespace catcut
