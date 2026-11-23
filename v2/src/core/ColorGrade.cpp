#include "core/ColorGrade.h"
#include <QJsonArray>

#include <QFile>
#include <QTextStream>
#include <algorithm>
#include <cmath>

namespace catcut {

namespace {

double clampd(double v, double lo, double hi) { return std::clamp(v, lo, hi); }
float clampf(float v, float lo, float hi) { return std::clamp(v, lo, hi); }

// Linear interpolation between control points (x fixed at 0,.25,.5,.75,1).
double curveEval(const std::array<double, 5>& pts, double x)
{
    x = clampd(x, 0.0, 1.0);
    const double scaled = x * 4.0;
    const int i = std::min(3, static_cast<int>(scaled));
    const double f = scaled - i;
    return pts[static_cast<size_t>(i)] * (1.0 - f) + pts[static_cast<size_t>(i + 1)] * f;
}

} // namespace

RgbCurves::RgbCurves()
{
    for (auto& channel : points) {
        channel = {0.0, 0.25, 0.5, 0.75, 1.0};
    }
}

bool RgbCurves::isIdentity() const
{
    for (const auto& channel : points) {
        for (int i = 0; i < 5; ++i) {
            if (channel[static_cast<size_t>(i)] != static_cast<double>(i) / 4.0)
                return false;
        }
    }
    return true;
}

std::array<float, 1024> RgbCurves::buildTable() const
{
    std::array<float, 1024> table{};
    for (int ch = 0; ch < 4; ++ch) {
        for (int i = 0; i < 256; ++i) {
            const double x = static_cast<double>(i) / 255.0;
            table[static_cast<size_t>(ch * 256 + i)] =
                static_cast<float>(clampd(curveEval(points[static_cast<size_t>(ch)], x), 0.0, 1.0));
        }
    }
    return table;
}

QJsonObject RgbCurves::toJson() const
{
    QJsonObject o;
    const char* names[4] = {"master", "red", "green", "blue"};
    for (int ch = 0; ch < 4; ++ch) {
        QJsonArray arr;
        for (double v : points[static_cast<size_t>(ch)])
            arr.append(v);
        o.insert(QLatin1String(names[ch]), arr);
    }
    return o;
}

RgbCurves RgbCurves::fromJson(const QJsonObject& o)
{
    RgbCurves curves;
    const char* names[4] = {"master", "red", "green", "blue"};
    for (int ch = 0; ch < 4; ++ch) {
        const QJsonArray arr = o.value(QLatin1String(names[ch])).toArray();
        if (arr.size() == 5) {
            for (int i = 0; i < 5; ++i)
                curves.points[static_cast<size_t>(ch)][static_cast<size_t>(i)] =
                    clampd(arr[i].toDouble(static_cast<double>(i) / 4.0), 0.0, 1.0);
        }
    }
    return curves;
}

// ---------------------------------------------------------------- CubeLut

void CubeLut::sample(float r, float g, float b, float& outR, float& outG, float& outB) const
{
    if (!isValid()) {
        outR = r;
        outG = g;
        outB = b;
        return;
    }
    // Map into LUT domain, then into lattice coordinates.
    const float fr = clampf((r - domainMin[0]) / (domainMax[0] - domainMin[0]), 0.0f, 1.0f) * (size - 1);
    const float fg = clampf((g - domainMin[1]) / (domainMax[1] - domainMin[1]), 0.0f, 1.0f) * (size - 1);
    const float fb = clampf((b - domainMin[2]) / (domainMax[2] - domainMin[2]), 0.0f, 1.0f) * (size - 1);
    const int r0 = std::min(size - 2, static_cast<int>(fr));
    const int g0 = std::min(size - 2, static_cast<int>(fg));
    const int b0 = std::min(size - 2, static_cast<int>(fb));
    const float tr = fr - r0, tg = fg - g0, tb = fb - b0;
    float acc[3] = {0.0f, 0.0f, 0.0f};
    for (int db = 0; db <= 1; ++db) {
        for (int dg = 0; dg <= 1; ++dg) {
            for (int dr = 0; dr <= 1; ++dr) {
                const float w = (dr ? tr : 1.0f - tr) * (dg ? tg : 1.0f - tg) * (db ? tb : 1.0f - tb);
                const int idx = ((r0 + dr) + (g0 + dg) * size + (b0 + db) * size * size) * 3;
                acc[0] += w * data[idx];
                acc[1] += w * data[idx + 1];
                acc[2] += w * data[idx + 2];
            }
        }
    }
    outR = acc[0];
    outG = acc[1];
    outB = acc[2];
}

bool parseCubeLut(const QString& text, CubeLut& out, QString& error)
{
    CubeLut lut;
    int size = 0;
    QVector<float> values;
    values.reserve(17 * 17 * 17 * 3);
    int lineNo = 0;
    for (const QString& rawLine : text.split('\n')) {
        ++lineNo;
        const QString line = rawLine.trimmed();
        if (line.isEmpty() || line.startsWith('#'))
            continue;
        if (line.startsWith(QLatin1String("TITLE"))) {
            lut.title = line.mid(5).trimmed().remove('"');
            continue;
        }
        if (line.startsWith(QLatin1String("LUT_3D_SIZE"))) {
            bool ok = false;
            size = line.mid(11).trimmed().toInt(&ok);
            if (!ok || size < 2 || size > 256) {
                error = QStringLiteral(".cube 第 %1 行：LUT_3D_SIZE 无效。").arg(lineNo);
                return false;
            }
            lut.size = size;
            continue;
        }
        if (line.startsWith(QLatin1String("DOMAIN_MIN"))) {
            const QStringList parts = line.mid(10).trimmed().split(' ', Qt::SkipEmptyParts);
            if (parts.size() == 3) {
                for (int i = 0; i < 3; ++i)
                    lut.domainMin[i] = parts[i].toFloat();
            }
            continue;
        }
        if (line.startsWith(QLatin1String("DOMAIN_MAX"))) {
            const QStringList parts = line.mid(10).trimmed().split(' ', Qt::SkipEmptyParts);
            if (parts.size() == 3) {
                for (int i = 0; i < 3; ++i)
                    lut.domainMax[i] = parts[i].toFloat();
            }
            continue;
        }
        if (line.startsWith(QLatin1String("LUT_1D_SIZE")) || line.startsWith(QLatin1String("LUT_3D_INPUT_RANGE"))) {
            error = QStringLiteral(".cube 第 %1 行：只支持 3D LUT，不支持 1D LUT。").arg(lineNo);
            return false;
        }
        // Data line: three floats.
        const QStringList parts = line.split(' ', Qt::SkipEmptyParts);
        if (parts.size() != 3) {
            error = QStringLiteral(".cube 第 %1 行：数据行必须是三个数字。").arg(lineNo);
            return false;
        }
        bool okR = false, okG = false, okB = false;
        const float r = parts[0].toFloat(&okR);
        const float g = parts[1].toFloat(&okG);
        const float b = parts[2].toFloat(&okB);
        if (!okR || !okG || !okB) {
            error = QStringLiteral(".cube 第 %1 行：数字解析失败。").arg(lineNo);
            return false;
        }
        values.append(r);
        values.append(g);
        values.append(b);
    }
    if (size < 2) {
        error = QStringLiteral(".cube 缺少 LUT_3D_SIZE。");
        return false;
    }
    if (values.size() != size * size * size * 3) {
        error = QStringLiteral(".cube 数据不完整：期望 %1 个值，实际 %2 个。")
                    .arg(size * size * size * 3)
                    .arg(values.size());
        return false;
    }
    lut.data = values;
    out = lut;
    return true;
}

bool loadCubeLutFile(const QString& path, CubeLut& out, QString& error)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        error = QStringLiteral("打不开 LUT 文件：%1").arg(path);
        return false;
    }
    const QString text = QString::fromUtf8(file.readAll());
    if (!parseCubeLut(text, out, error))
        return false;
    out.sourcePath = path;
    return true;
}

// ---------------------------------------------------------------- ColorGrade

bool ColorGrade::isIdentity() const
{
    if (temperature != 0.0 || tint != 0.0 || lutEnabled)
        return false;
    for (const HslZone& z : hslZones) {
        if (!z.isIdentity())
            return false;
    }
    for (const ColorWheel& w : wheels) {
        if (!w.isIdentity())
            return false;
    }
    return curves.isIdentity();
}

void ColorGrade::rgbToHsl(float r, float g, float b, float& h, float& s, float& l)
{
    const float mx = std::max({r, g, b});
    const float mn = std::min({r, g, b});
    l = (mx + mn) * 0.5f;
    if (mx == mn) {
        h = 0.0f;
        s = 0.0f;
        return;
    }
    const float d = mx - mn;
    s = l > 0.5f ? d / (2.0f - mx - mn) : d / (mx + mn);
    if (mx == r)
        h = (g - b) / d + (g < b ? 6.0f : 0.0f);
    else if (mx == g)
        h = (b - r) / d + 2.0f;
    else
        h = (r - g) / d + 4.0f;
    h /= 6.0f;
}

void ColorGrade::hslToRgb(float h, float s, float l, float& r, float& g, float& b)
{
    if (s == 0.0f) {
        r = g = b = l;
        return;
    }
    const float q = l < 0.5f ? l * (1.0f + s) : l + s - l * s;
    const float p = 2.0f * l - q;
    auto hue2rgb = [](float p_, float q_, float t) {
        if (t < 0.0f) t += 1.0f;
        if (t > 1.0f) t -= 1.0f;
        if (t < 1.0f / 6.0f) return p_ + (q_ - p_) * 6.0f * t;
        if (t < 1.0f / 2.0f) return q_;
        if (t < 2.0f / 3.0f) return p_ + (q_ - p_) * (2.0f / 3.0f - t) * 6.0f;
        return p_;
    };
    r = hue2rgb(p, q, h + 1.0f / 3.0f);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1.0f / 3.0f);
}

double ColorGrade::zoneWeight(double hueTurns, int zone)
{
    double d = std::fabs(hueTurns - kZoneHues[zone]);
    if (d > 0.5)
        d = 1.0 - d; // circular distance
    return clampd(1.0 - d / kZoneHalfWidth, 0.0, 1.0);
}

float ColorGrade::sampleCurveTable(const std::array<float, 1024>& table, int channel, float x)
{
    x = clampf(x, 0.0f, 1.0f) * 255.0f;
    const int i = std::min(254, static_cast<int>(x));
    const float f = x - i;
    const float a = table[static_cast<size_t>(channel * 256 + i)];
    const float b = table[static_cast<size_t>(channel * 256 + i + 1)];
    return a * (1.0f - f) + b * f;
}

void ColorGrade::applyPixel(float r, float g, float b, float& outR, float& outG, float& outB,
                            const std::array<float, 1024>& curveTable) const
{
    // 1. Input conversion: sRGB -> linear (pow 2.2 approx).
    r = std::pow(clampf(r, 0.0f, 1.0f), 2.2f);
    g = std::pow(clampf(g, 0.0f, 1.0f), 2.2f);
    b = std::pow(clampf(b, 0.0f, 1.0f), 2.2f);

    // 2. White balance (linear gains; temp warm +, tint green +).
    const double temp = clampd(temperature, -1.0, 1.0);
    const double tintV = clampd(tint, -1.0, 1.0);
    r = static_cast<float>(r * (1.0 + 0.4 * temp) * (1.0 - 0.15 * tintV));
    g = static_cast<float>(g * (1.0 + 0.3 * tintV));
    b = static_cast<float>(b * (1.0 - 0.4 * temp) * (1.0 - 0.15 * tintV));

    // 3. HSL zones (work in HSL on the linear values; hue is
    // gamma-independent, saturation/lightness deltas are small).
    {
        float h, s, l;
        rgbToHsl(clampf(r, 0.0f, 1.0f), clampf(g, 0.0f, 1.0f), clampf(b, 0.0f, 1.0f), h, s, l);
        double hueShift = 0.0, satDelta = 0.0, lightDelta = 0.0;
        for (int z = 0; z < 7; ++z) {
            const double w = zoneWeight(h, z);
            if (w <= 0.0)
                continue;
            hueShift += w * hslZones[static_cast<size_t>(z)].hueShift;
            satDelta += w * hslZones[static_cast<size_t>(z)].saturation;
            lightDelta += w * hslZones[static_cast<size_t>(z)].lightness;
        }
        if (hueShift != 0.0 || satDelta != 0.0 || lightDelta != 0.0) {
            h = static_cast<float>(std::fmod(h + hueShift + 1.0, 1.0));
            s = clampf(s * static_cast<float>(1.0 + satDelta), 0.0f, 1.0f);
            l = clampf(l + static_cast<float>(lightDelta), 0.0f, 1.0f);
            hslToRgb(h, s, l, r, g, b);
        }
    }

    // 4. Colour wheels: zone weights from luma (linear Rec.709).
    {
        const float luma = clampf(0.2126f * r + 0.7152f * g + 0.0722f * b, 0.0f, 1.0f);
        const double shadowW = (1.0 - luma) * (1.0 - luma);
        const double highW = static_cast<double>(luma) * luma;
        const double midW = std::max(0.0, 1.0 - shadowW - highW);
        const double or_ = wheels[3].r + shadowW * wheels[0].r + midW * wheels[1].r + highW * wheels[2].r;
        const double og = wheels[3].g + shadowW * wheels[0].g + midW * wheels[1].g + highW * wheels[2].g;
        const double ob = wheels[3].b + shadowW * wheels[0].b + midW * wheels[1].b + highW * wheels[2].b;
        r = static_cast<float>(r + or_);
        g = static_cast<float>(g + og);
        b = static_cast<float>(b + ob);
    }

    // 5. Curves: per-channel first, then master (same 256 tables the
    // GPU shader samples).
    r = sampleCurveTable(curveTable, 0, sampleCurveTable(curveTable, 1, clampf(r, 0.0f, 1.0f)));
    g = sampleCurveTable(curveTable, 0, sampleCurveTable(curveTable, 2, clampf(g, 0.0f, 1.0f)));
    b = sampleCurveTable(curveTable, 0, sampleCurveTable(curveTable, 3, clampf(b, 0.0f, 1.0f)));

    // 6. LUT (trilinear; skipped when disabled or invalid).
    if (lutEnabled && lut.isValid())
        lut.sample(clampf(r, 0.0f, 1.0f), clampf(g, 0.0f, 1.0f), clampf(b, 0.0f, 1.0f), r, g, b);

    // 7. Output conversion: linear -> sRGB (inverse pow).
    outR = std::pow(clampf(r, 0.0f, 1.0f), 1.0f / 2.2f);
    outG = std::pow(clampf(g, 0.0f, 1.0f), 1.0f / 2.2f);
    outB = std::pow(clampf(b, 0.0f, 1.0f), 1.0f / 2.2f);
}

void ColorGrade::applyPixel(float r, float g, float b, float& outR, float& outG, float& outB) const
{
    applyPixel(r, g, b, outR, outG, outB, curves.buildTable());
}

void ColorGrade::applyToImage(QImage& image) const
{
    if (image.isNull() || isIdentity())
        return;
    if (image.format() != QImage::Format_RGBA8888)
        image = image.convertToFormat(QImage::Format_RGBA8888);
    const std::array<float, 1024> table = curves.buildTable();
    for (int y = 0; y < image.height(); ++y) {
        uint8_t* row = image.scanLine(y);
        for (int x = 0; x < image.width(); ++x) {
            uint8_t* px = row + x * 4;
            float r, g, b;
            applyPixel(px[0] / 255.0f, px[1] / 255.0f, px[2] / 255.0f, r, g, b, table);
            px[0] = static_cast<uint8_t>(clampf(r, 0.0f, 1.0f) * 255.0f + 0.5f);
            px[1] = static_cast<uint8_t>(clampf(g, 0.0f, 1.0f) * 255.0f + 0.5f);
            px[2] = static_cast<uint8_t>(clampf(b, 0.0f, 1.0f) * 255.0f + 0.5f);
        }
    }
}

QJsonObject ColorGrade::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("temperature"), temperature);
    o.insert(QStringLiteral("tint"), tint);
    QJsonArray hsl;
    for (const HslZone& z : hslZones) {
        QJsonObject zo;
        zo.insert(QStringLiteral("hueShift"), z.hueShift);
        zo.insert(QStringLiteral("saturation"), z.saturation);
        zo.insert(QStringLiteral("lightness"), z.lightness);
        hsl.append(zo);
    }
    o.insert(QStringLiteral("hsl"), hsl);
    const char* wheelNames[4] = {"shadows", "midtones", "highlights", "global"};
    for (int i = 0; i < 4; ++i) {
        QJsonObject wo;
        wo.insert(QStringLiteral("r"), wheels[i].r);
        wo.insert(QStringLiteral("g"), wheels[i].g);
        wo.insert(QStringLiteral("b"), wheels[i].b);
        o.insert(QLatin1String(wheelNames[i]), wo);
    }
    o.insert(QStringLiteral("curves"), curves.toJson());
    o.insert(QStringLiteral("lutEnabled"), lutEnabled);
    o.insert(QStringLiteral("lutPath"), lut.sourcePath);
    return o;
}

ColorGrade ColorGrade::fromJson(const QJsonObject& o)
{
    ColorGrade grade;
    grade.temperature = clampd(o.value(QStringLiteral("temperature")).toDouble(0.0), -1.0, 1.0);
    grade.tint = clampd(o.value(QStringLiteral("tint")).toDouble(0.0), -1.0, 1.0);
    const QJsonArray hsl = o.value(QStringLiteral("hsl")).toArray();
    for (int i = 0; i < 7 && i < hsl.size(); ++i) {
        const QJsonObject zo = hsl[i].toObject();
        grade.hslZones[static_cast<size_t>(i)].hueShift =
            clampd(zo.value(QStringLiteral("hueShift")).toDouble(0.0), -0.5, 0.5);
        grade.hslZones[static_cast<size_t>(i)].saturation =
            clampd(zo.value(QStringLiteral("saturation")).toDouble(0.0), -1.0, 1.0);
        grade.hslZones[static_cast<size_t>(i)].lightness =
            clampd(zo.value(QStringLiteral("lightness")).toDouble(0.0), -1.0, 1.0);
    }
    const char* wheelNames[4] = {"shadows", "midtones", "highlights", "global"};
    for (int i = 0; i < 4; ++i) {
        const QJsonObject wo = o.value(QLatin1String(wheelNames[i])).toObject();
        grade.wheels[i].r = clampd(wo.value(QStringLiteral("r")).toDouble(0.0), -1.0, 1.0);
        grade.wheels[i].g = clampd(wo.value(QStringLiteral("g")).toDouble(0.0), -1.0, 1.0);
        grade.wheels[i].b = clampd(wo.value(QStringLiteral("b")).toDouble(0.0), -1.0, 1.0);
    }
    grade.curves = RgbCurves::fromJson(o.value(QStringLiteral("curves")).toObject());
    grade.lutEnabled = o.value(QStringLiteral("lutEnabled")).toBool(false);
    grade.lut.sourcePath = o.value(QStringLiteral("lutPath")).toString();
    // NOTE: the LUT file itself is NOT embedded in the project. The
    // caller re-loads lutPath (and clears lutEnabled with a readable
    // note when the file is gone) — a missing LUT must never silently
    // become an identity grade without telling the user.
    return grade;
}

// ---------------------------------------------------------------- scopes

ColorScopes::ColorScopes()
{
    for (int i = 0; i < 256; ++i) {
        waveMin[i] = 1.0f;
        waveMax[i] = 0.0f;
    }
}

ColorScopes ColorScopes::compute(const QImage& image)
{
    ColorScopes scopes;
    if (image.isNull() || image.width() <= 0 || image.height() <= 0)
        return scopes;
    const QImage rgba = image.format() == QImage::Format_RGBA8888
        ? image : image.convertToFormat(QImage::Format_RGBA8888);
    const int w = rgba.width(), h = rgba.height();
    scopes.pixelCount = w * h;
    for (int y = 0; y < h; ++y) {
        const uint8_t* row = rgba.constScanLine(y);
        for (int x = 0; x < w; ++x) {
            const uint8_t* px = row + x * 4;
            const int r = px[0], g = px[1], b = px[2];
            scopes.histR[r]++;
            scopes.histG[g]++;
            scopes.histB[b]++;
            const float luma = 0.2126f * r + 0.7152f * g + 0.0722f * b;
            scopes.histLuma[static_cast<int>(luma)]++;
            const int waveCol = (x * 256) / w;
            const float ln = luma / 255.0f;
            if (ln < scopes.waveMin[waveCol]) scopes.waveMin[waveCol] = ln;
            if (ln > scopes.waveMax[waveCol]) scopes.waveMax[waveCol] = ln;
            // Vectorscope: x = (B-Y) scaled, y = (R-Y) scaled, centre 64,64.
            const float yv = luma;
            const float cb = (b - yv) / 255.0f; // -0.5..0.5 roughly
            const float cr = (r - yv) / 255.0f;
            const int vx = std::clamp(static_cast<int>(64.0f + cb * 128.0f), 0, 127);
            const int vy = std::clamp(static_cast<int>(64.0f - cr * 128.0f), 0, 127);
            scopes.vectorGrid[static_cast<size_t>(vy * 128 + vx)] += 1.0f;
        }
    }
    // Columns no pixel wrote to keep the init values (min 1.0 > max 0.0);
    // normalise them to an empty range so callers never see min > max.
    for (int i = 0; i < 256; ++i) {
        if (scopes.waveMin[i] > scopes.waveMax[i]) {
            scopes.waveMin[i] = 0.0f;
            scopes.waveMax[i] = 0.0f;
        }
    }
    return scopes;
}

int ColorScopes::histTotal() const
{
    int total = 0;
    for (int i = 0; i < 256; ++i)
        total += histR[i];
    return total;
}

} // namespace catcut
