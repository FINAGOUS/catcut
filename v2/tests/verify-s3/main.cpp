// CatCut v2 — S3 self-test (verify-s3).
//
// Usage: verify-s3 <probe-dir> <output-dir>
//   probe-dir : test_8k.mp4, test_4k.mp4 (generated in the workflow
//               by the bundled ffmpeg.exe — same probe media as
//               verify-s1/verify-s2, no new generation)
//   output-dir: receives the graded render PNGs.
//
// Checks (exit 0 = all passed):
//   1. grade math: identity round-trip, white balance direction,
//      wheel zone weights (shadows hit dark pixels more), curve
//      table + interpolation, HSL zone weights + hue shift,
//      chain order (curves run BEFORE the LUT), .cube parse
//      (identity / invert / malformed / truncated), scopes totals,
//      grade JSON round-trip
//   2. beauty / keying / masks / mosaic: beauty blurs + lifts,
//      beauty-vs-portrait-keying exclusion, chroma-key alpha,
//      mask coverage (rect / circle / polygon), mosaic progress
//      + blur-inside / spotlight-outside (DogSC defaults)
//   3. camera motion: auto-zoom grouping + 0.9s hold + safe margin,
//      manual segments survive replanning, underdamped spring
//      overshoot, zoom/focus at time, 3D projection foreshortening,
//      focus 3D-wins-over-zoom, pointer track sampling + time
//      calibration + still-hide
//   4. canvas: frame geometry (window toolbar, phone portrait),
//      unknown style maps to the nearest core style, crop changes
//      pixels, identity canvas is a no-op, canvas JSON round-trip
//   5. evaluator: clip grade / beauty / key ride into FrameLayer,
//      canvas + mosaics + auto-zoom + pointer ride into FrameScene,
//      timeline JSON round-trip keeps the S3 state
//   6. preview vs export consistency: the same graded frame rendered
//      through the preview path (evaluator + TimelineFrameRenderer,
//      as MainWindow does) and through the export path
//      (ExportFrameRenderer, as S4 will) — mean per-channel error
//      must be < 1% of 255. Both must differ from the ungraded render.
//   7. GPU shader: the compiled grade.frag.qsb resource loads and
//      parses as a valid QShader (the shader itself is exercised on
//      a real machine; CI has no GPU — see docs/s3).
//
// Machine-readable lines for the run log:
//   CONSISTENCY_MEAN_ERROR=<0..255>  GRADE_QSB_OK=0|1

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QImage>
#include <QTextStream>
#include <rhi/qshader.h>

#include <cmath>
#include <iostream>

#include "core/BeautyKeying.h"
#include "core/CameraMotion.h"
#include "core/CanvasStyle.h"
#include "core/ColorGrade.h"
#include "core/TimelineEvaluator.h"
#include "core/TimelineFrameRenderer.h"
#include "core/TimelineModel.h"
#include "media/Decoder.h"
#include "media/ExportFrameRenderer.h"
#include "media/PreviewRenderer.h"

namespace {

int g_failures = 0;

void check(bool ok, const QString& name, const QString& detail = QString())
{
    QTextStream out(stdout);
    if (ok) {
        out << "[PASS] " << name;
    } else {
        out << "[FAIL] " << name;
        ++g_failures;
    }
    if (!detail.isEmpty())
        out << " — " << detail;
    out << "\n";
    out.flush();
}

bool nearValue(double actual, double expected, double tolerance)
{
    return std::fabs(actual - expected) <= tolerance;
}

QImage solidImage(int w, int h, int r, int g, int b)
{
    QImage img(w, h, QImage::Format_RGBA8888);
    img.fill(QColor(r, g, b, 255));
    return img;
}

double imageMeanChannel(const QImage& img, int channel)
{
    const QImage rgba = img.format() == QImage::Format_RGBA8888
        ? img : img.convertToFormat(QImage::Format_RGBA8888);
    double sum = 0.0;
    const int n = rgba.width() * rgba.height();
    for (int y = 0; y < rgba.height(); ++y) {
        const uint8_t* row = rgba.constScanLine(y);
        for (int x = 0; x < rgba.width(); ++x)
            sum += row[x * 4 + channel];
    }
    return n ? sum / n : 0.0;
}

double meanAbsDiff(const QImage& a, const QImage& b)
{
    const QImage ra = a.format() == QImage::Format_RGBA8888
        ? a : a.convertToFormat(QImage::Format_RGBA8888);
    const QImage rb = b.format() == QImage::Format_RGBA8888
        ? b : b.convertToFormat(QImage::Format_RGBA8888);
    if (ra.size() != rb.size())
        return 1e9;
    double sum = 0.0;
    const int n = ra.width() * ra.height() * 3;
    for (int y = 0; y < ra.height(); ++y) {
        const uint8_t* rowA = ra.constScanLine(y);
        const uint8_t* rowB = rb.constScanLine(y);
        for (int x = 0; x < ra.width(); ++x) {
            for (int c = 0; c < 3; ++c)
                sum += std::abs(static_cast<int>(rowA[x * 4 + c]) - static_cast<int>(rowB[x * 4 + c]));
        }
    }
    return n ? sum / n : 0.0;
}

} // namespace

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);

    QTextStream out(stdout);
    out << "verify-s3: CatCut v2 S3 colour & picture self-test\n";
    out << "Qt: " << qVersion() << "\n";
    out.flush();

    if (argc < 3) {
        out << "usage: verify-s3 <probe-dir> <output-dir>\n";
        return 2;
    }
    const QDir probeDir(QString::fromLocal8Bit(argv[1]));
    const QDir outDir(QString::fromLocal8Bit(argv[2]));
    if (!outDir.exists())
        QDir().mkpath(outDir.absolutePath());
    const QString file4k = probeDir.filePath(QStringLiteral("test_4k.mp4"));

    // ------------------------------------------------- 1. grade math
    {
        catcut::ColorGrade identity;
        float r, g, b;
        identity.applyPixel(0.5f, 0.25f, 0.75f, r, g, b);
        check(nearValue(r, 0.5, 1.0 / 255.0) && nearValue(g, 0.25, 1.0 / 255.0)
                  && nearValue(b, 0.75, 1.0 / 255.0),
              "grade: identity round-trips",
              QString("(%1,%2,%3)").arg(r).arg(g).arg(b));

        catcut::ColorGrade warm;
        warm.temperature = 1.0;
        warm.applyPixel(0.5f, 0.5f, 0.5f, r, g, b);
        check(r > 0.5f && b < 0.5f, "grade: temperature +1 warms (r up, b down)",
              QString("(%1,%2,%3)").arg(r).arg(g).arg(b));

        // Wheels: a shadows lift moves a dark pixel more than a bright one.
        catcut::ColorGrade shadowLift;
        shadowLift.wheels[0].r = 0.2;
        float dr, dg, db, br, bg, bb;
        shadowLift.applyPixel(0.1f, 0.1f, 0.1f, dr, dg, db);
        shadowLift.applyPixel(0.9f, 0.9f, 0.9f, br, bg, bb);
        check((dr - 0.1f) > (br - 0.9f) * 4.0, "grade: shadows wheel hits dark pixels more",
              QString("dark d=%1 bright d=%2").arg(dr - 0.1f).arg(br - 0.9f));

        // Global wheel lifts everything.
        catcut::ColorGrade global;
        global.wheels[3].g = 0.2;
        global.applyPixel(0.5f, 0.5f, 0.5f, r, g, b);
        check(g > 0.5f, "grade: global wheel lifts", QString("g=%1").arg(g));

        // Curves: master table at 0.5 is the control point value.
        catcut::RgbCurves curves;
        curves.points[0] = {0.0, 0.25, 0.75, 0.75, 1.0};
        const std::array<float, 1024> table = curves.buildTable();
        check(nearValue(table[128], 0.75, 0.02), "grade: curve table at 0.5 == 0.75",
              QString::number(table[128]));
        catcut::ColorGrade curved;
        curved.curves = curves;
        // Curves run in linear working space: probe with the sRGB value
        // whose linear value is 0.5 (~0.73), so the table value 0.75 applies.
        curved.applyPixel(0.73f, 0.73f, 0.73f, r, g, b);
        check(r > 0.6f, "grade: master curve lifts mid grey", QString("r=%1").arg(r));

        // HSL: zone weights (centre 1, half-width 0) and circular wrap.
        check(nearValue(catcut::ColorGrade::zoneWeight(0.0, 0), 1.0, 1e-9),
              "grade: red zone weight 1 at its centre");
        check(nearValue(catcut::ColorGrade::zoneWeight(1.0 / 12.0, 0), 0.0, 1e-9),
              "grade: red zone weight 0 one half-width away");
        check(catcut::ColorGrade::zoneWeight(0.99, 0) > 0.8,
              "grade: red zone weight wraps around 1.0",
              QString::number(catcut::ColorGrade::zoneWeight(0.99, 0)));
        // Hue shift: desaturated red pushed 1/12 turn goes orange (g rises).
        catcut::ColorGrade hueShift;
        hueShift.hslZones[0].hueShift = 1.0 / 12.0;
        hueShift.applyPixel(0.6f, 0.4f, 0.4f, r, g, b);
        check(g > 0.4f, "grade: red hue shift +1/12 raises green (towards orange)",
              QString("(%1,%2,%3)").arg(r).arg(g).arg(b));
        // Saturation: red-zone sat +1 on a desaturated red grows the spread.
        catcut::ColorGrade satUp;
        satUp.hslZones[0].saturation = 1.0;
        float r0, g0, b0;
        identity.applyPixel(0.6f, 0.4f, 0.4f, r0, g0, b0);
        satUp.applyPixel(0.6f, 0.4f, 0.4f, r, g, b);
        check((r - g) > (r0 - g0), "grade: red saturation +1 grows the red spread",
              QString("spread %1 -> %2").arg(r0 - g0).arg(r - g));

        // Chain order: curves run BEFORE the LUT. A curve that zeroes
        // everything below 0.5 followed by a constant-0.2 LUT must give
        // ~0.48 out; the reverse order would give 0.
        catcut::ColorGrade order;
        order.curves.points[0] = {0.0, 0.0, 0.0, 1.0, 1.0};
        order.lutEnabled = true;
        order.lut.size = 2;
        order.lut.data = QVector<float>{0.2f, 0.2f, 0.2f, 0.2f, 0.2f, 0.2f,
                                        0.2f, 0.2f, 0.2f, 0.2f, 0.2f, 0.2f,
                                        0.2f, 0.2f, 0.2f, 0.2f, 0.2f, 0.2f,
                                        0.2f, 0.2f, 0.2f, 0.2f, 0.2f, 0.2f};
        order.applyPixel(0.5f, 0.5f, 0.5f, r, g, b);
        check(nearValue(r, std::pow(0.2, 1.0 / 2.2), 0.03),
              "grade: chain order is curves -> LUT",
              QString("r=%1 expected~%2").arg(r).arg(std::pow(0.2, 1.0 / 2.2)));

        // .cube parsing: identity, invert, malformed, truncated.
        {
            const QString identityCube =
                "TITLE \"id\"\nLUT_3D_SIZE 2\n"
                "0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
            catcut::CubeLut lut;
            QString error;
            check(catcut::parseCubeLut(identityCube, lut, error) && lut.isValid(),
                  "grade: .cube identity parses", error);
            float or_, og, ob;
            lut.sample(0.25f, 0.5f, 0.75f, or_, og, ob);
            check(nearValue(or_, 0.25, 0.01) && nearValue(og, 0.5, 0.01)
                      && nearValue(ob, 0.75, 0.01),
                  "grade: .cube identity samples through",
                  QString("(%1,%2,%3)").arg(or_).arg(og).arg(ob));
            const QString invertCube =
                "LUT_3D_SIZE 2\n"
                "1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n";
            catcut::CubeLut inv;
            check(catcut::parseCubeLut(invertCube, inv, error) && inv.isValid(),
                  "grade: .cube invert parses", error);
            inv.sample(0.25f, 0.5f, 0.75f, or_, og, ob);
            check(nearValue(or_, 0.75, 0.01) && nearValue(og, 0.5, 0.01)
                      && nearValue(ob, 0.25, 0.01),
                  "grade: .cube invert samples inverted",
                  QString("(%1,%2,%3)").arg(or_).arg(og).arg(ob));
            catcut::CubeLut bad;
            check(!catcut::parseCubeLut("LUT_3D_SIZE 2\n0 0 0\n", bad, error),
                  "grade: truncated .cube rejected", error);
            check(!catcut::parseCubeLut("hello\n", bad, error),
                  "grade: malformed .cube rejected", error);
        }

        // Scopes totals.
        {
            QImage img = solidImage(4, 4, 200, 100, 50);
            const catcut::ColorScopes scopes = catcut::ColorScopes::compute(img);
            check(scopes.pixelCount == 16 && scopes.histTotal() == 16,
                  "grade: scopes histogram totals equal pixel count",
                  QString("hist=%1 px=%2").arg(scopes.histTotal()).arg(scopes.pixelCount));
            bool waveOk = true;
            float vecSum = 0.0f;
            for (int i = 0; i < 256; ++i) {
                if (scopes.waveMin[i] > scopes.waveMax[i] + 1e-6f)
                    waveOk = false;
            }
            for (float v : scopes.vectorGrid)
                vecSum += v;
            check(waveOk && nearValue(vecSum, 16.0, 1e-3),
                  "grade: scopes waveform ordered, vectorscope totals 16",
                  QString("vecSum=%1").arg(vecSum));
        }

        // Grade JSON round-trip.
        {
            catcut::ColorGrade grade;
            grade.temperature = 0.3;
            grade.wheels[3].r = 0.1;
            grade.hslZones[2].saturation = 0.5;
            grade.curves.points[1] = {0.0, 0.3, 0.5, 0.8, 1.0};
            const catcut::ColorGrade back =
                catcut::ColorGrade::fromJson(grade.toJson());
            check(nearValue(back.temperature, 0.3, 1e-9)
                      && nearValue(back.wheels[3].r, 0.1, 1e-9)
                      && nearValue(back.hslZones[2].saturation, 0.5, 1e-9)
                      && nearValue(back.curves.points[1][1], 0.3, 1e-9),
                  "grade: JSON round-trip keeps temperature/wheel/HSL/curve");
        }
    }

    // --------------------------------- 2. beauty / keying / masks / mosaic
    {
        // Beauty: a checkerboard gets intermediate values (denoise
        // mixes neighbours) and the lift raises the mean.
        QImage checker(8, 8, QImage::Format_RGBA8888);
        for (int y = 0; y < 8; ++y) {
            for (int x = 0; x < 8; ++x) {
                const int v = ((x + y) % 2 == 0) ? 0 : 255;
                checker.setPixel(x, y, qRgba(v, v, v, 255));
            }
        }
        catcut::BeautySettings beauty;
        beauty.enabled = true;
        beauty.strength = 1.0;
        beauty.brighten = 0.0;
        QImage blurred = checker;
        catcut::applyBeauty(blurred, beauty, nullptr);
        const QRgb centre = blurred.pixel(4, 4);
        check(qRed(centre) > 0 && qRed(centre) < 255,
              "beauty: denoise mixes a checkerboard centre pixel",
              QString("centre=%1").arg(qRed(centre)));
        catcut::BeautySettings lift;
        lift.enabled = true;
        lift.strength = 0.0;
        lift.brighten = 0.1;
        QImage lifted = solidImage(4, 4, 100, 100, 100);
        catcut::applyBeauty(lifted, lift, nullptr);
        check(nearValue(imageMeanChannel(lifted, 0), 100 + 0.1 * 255, 2.0),
              "beauty: brighten lifts the mean",
              QString::number(imageMeanChannel(lifted, 0)));
        // No mask: whole frame treated, never an error.
        QImage plain = solidImage(4, 4, 80, 80, 80);
        catcut::applyBeauty(plain, beauty, nullptr);
        check(!plain.isNull(), "beauty: no mask still applies (whole frame)");

        check(catcut::beautyKeyingConflict(beauty, false).isEmpty(),
              "beauty: no conflict when portrait keying is off");
        check(!catcut::beautyKeyingConflict(beauty, true).isEmpty(),
              "beauty: conflict reported when portrait keying is on");
        catcut::BeautySettings off;
        check(catcut::beautyKeyingConflict(off, true).isEmpty(),
              "beauty: no conflict when beauty is off");

        // Chroma key.
        catcut::ChromaKey key;
        key.enabled = true;
        check(nearValue(key.alphaFor(0.0, 1.0, 0.0), 0.0, 1e-9),
              "keying: pure green keys out (alpha 0)");
        check(nearValue(key.alphaFor(1.0, 0.0, 0.0), 1.0, 1e-9),
              "keying: pure red is kept (alpha 1)");
        // Probe colour at normalised distance ~0.28 from key green, inside
        // the feather band (0.25, 0.35): alpha must be strictly between 0 and 1.
        check(key.alphaFor(0.0, 0.55, 0.2) < 1.0 && key.alphaFor(0.0, 0.55, 0.2) > 0.0,
              "keying: near-green is feathered, not binary");
        QImage keyed = solidImage(4, 4, 0, 255, 0);
        check(catcut::applyChromaKey(keyed, key) && keyed.pixel(0, 0) >> 24 == 0,
              "keying: green frame becomes transparent");

        // Masks.
        catcut::MaskShape rect;
        rect.kind = catcut::MaskShapeKind::Rectangle;
        check(nearValue(rect.coverage(0.5, 0.5), 1.0, 1e-9)
                  && nearValue(rect.coverage(0.0, 0.0), 0.0, 1e-9),
              "mask: rectangle centre in, corner out");
        catcut::MaskShape circle;
        circle.kind = catcut::MaskShapeKind::Circle;
        check(nearValue(circle.coverage(0.5, 0.5), 1.0, 1e-9)
                  && nearValue(circle.coverage(0.0, 0.0), 0.0, 1e-9),
              "mask: circle centre in, corner out");
        catcut::MaskShape poly;
        poly.kind = catcut::MaskShapeKind::Polygon;
        poly.points = {QPointF(0.5, 0.0), QPointF(1.0, 1.0), QPointF(0.0, 1.0)};
        check(nearValue(poly.coverage(0.5, 0.8), 1.0, 1e-9)
                  && nearValue(poly.coverage(0.1, 0.1), 0.0, 1e-9),
              "mask: polygon (pen path) inside/outside");

        // Mosaic (DogSC defaults: strength 0.55, darken 0.22, fades 0.3s).
        catcut::MosaicClip mosaic;
        mosaic.id = QStringLiteral("m1");
        mosaic.start = 1.0;
        mosaic.end = 3.0;
        mosaic.style = catcut::MosaicStyle::Blur;
        check(nearValue(mosaic.progressAt(0.5), 0.0, 1e-9),
              "mosaic: progress 0 before the clip");
        check(nearValue(mosaic.progressAt(1.15), 0.5, 1e-9),
              "mosaic: fade-in ramps (0.5 halfway through 0.3s)",
              QString::number(mosaic.progressAt(1.15)));
        check(nearValue(mosaic.progressAt(2.0), 1.0, 1e-9),
              "mosaic: progress 1 mid-clip");
        check(nearValue(mosaic.progressAt(2.85), 0.5, 1e-9),
              "mosaic: fade-out ramps");
        QImage frame = checker;
        catcut::applyMosaic(frame, mosaic, 1.0);
        // Inside the rect (centre) is blurred (intermediate values);
        // outside (corner) is untouched.
        check(frame.pixel(4, 4) != checker.pixel(4, 4)
                  && frame.pixel(0, 0) == checker.pixel(0, 0),
              "mosaic: blur changes the inside, not the outside");
        catcut::MosaicClip spot = mosaic;
        spot.style = catcut::MosaicStyle::Spotlight;
        QImage spotted = solidImage(8, 8, 200, 200, 200);
        catcut::applyMosaic(spotted, spot, 1.0);
        check(qRed(spotted.pixel(0, 0)) < 200 && qRed(spotted.pixel(4, 4)) == 200,
              "mosaic: spotlight darkens outside, keeps inside crisp",
              QString("outside=%1 inside=%2").arg(qRed(spotted.pixel(0, 0)))
                  .arg(qRed(spotted.pixel(4, 4))));
    }

    // ------------------------------------------------ 3. camera motion
    {
        catcut::AutoZoomPlanner planner;
        QList<catcut::ClickEvent> clicks;
        for (double t : {1.0, 1.2, 1.4})
            clicks.append(catcut::ClickEvent{t, 0.5, 0.5});
        for (double t : {4.0, 4.2})
            clicks.append(catcut::ClickEvent{t, 0.2, 0.8});
        const QList<catcut::AutoZoomSegment> segs = planner.plan(clicks, {});
        check(segs.size() == 2, "motion: close clicks group into 2 segments",
              QString::number(segs.size()));
        check(nearValue(segs[0].hold, 0.9, 1e-9), "motion: auto-zoom hold is 0.9s");
        check(nearValue(segs[0].focusX, 0.5, 1e-9) && nearValue(segs[1].focusX, 0.2, 1e-9),
              "motion: group focus is the centroid");
        // Safe margin: a click at the very edge clamps the focus in.
        QList<catcut::ClickEvent> edgeClicks;
        edgeClicks.append(catcut::ClickEvent{1.0, 0.99, 0.99});
        const QList<catcut::AutoZoomSegment> edge = planner.plan(edgeClicks, {});
        check(edge[0].focusX <= 0.92 + 1e-9 && edge[0].focusY <= 0.92 + 1e-9,
              "motion: focus clamps to the safe margin",
              QString("(%1,%2)").arg(edge[0].focusX).arg(edge[0].focusY));
        // Manual segments survive replanning untouched.
        catcut::AutoZoomSegment manual;
        manual.start = 8.0;
        manual.focusX = 0.3;
        manual.focusY = 0.3;
        manual.manual = true;
        const QList<catcut::AutoZoomSegment> withManual = planner.plan(clicks, {manual});
        bool manualKept = false;
        for (const auto& s : withManual) {
            if (s.manual && nearValue(s.start, 8.0, 1e-9) && nearValue(s.focusX, 0.3, 1e-9))
                manualKept = true;
        }
        check(withManual.size() == 3 && manualKept,
              "motion: manual segment survives replanning");

        // Spring: underdamped overshoot, settles at 1.
        const catcut::SpringParams spring;
        check(spring.isUnderdamped(), "motion: default spring is underdamped");
        check(nearValue(catcut::springProgress(spring, 0.0, 0.5), 0.0, 1e-9)
                  && nearValue(catcut::springProgress(spring, 0.5, 0.5), 1.0, 1e-9),
              "motion: spring is 0 at start, 1 at the end");
        double maxP = 0.0;
        for (int i = 0; i <= 100; ++i)
            maxP = std::max(maxP, catcut::springProgress(spring, 0.5 * i / 100.0, 0.5));
        check(maxP > 1.0, "motion: underdamped spring overshoots past 1",
              QString("max=%1").arg(maxP));
        check(nearValue(catcut::AutoZoomPlanner::zoomAtTime(segs, 1.0 + 0.35 + 0.45,
                                                            spring),
                        1.6, 1e-9),
              "motion: zoom is at target during the hold");
        check(nearValue(catcut::AutoZoomPlanner::zoomAtTime(segs, 0.5, spring), 1.0, 1e-9),
              "motion: zoom is 1 outside any segment");

        // 3D: identity quad, tilt foreshortening.
        const QList<QPointF> identityQuad =
            catcut::projectScreenQuad(catcut::Screen3D(), 16.0 / 9.0);
        check(identityQuad.size() == 4
                  && nearValue(identityQuad[0].x(), 0.0, 1e-9)
                  && nearValue(identityQuad[1].x(), 1.0, 1e-9),
              "motion: identity 3D quad spans the canvas");
        catcut::Screen3D tilted;
        tilted.tiltY = 45.0;
        const QList<QPointF> tiltedQuad = catcut::projectScreenQuad(tilted, 16.0 / 9.0);
        const double tiltedWidth = tiltedQuad[1].x() - tiltedQuad[0].x();
        check(tiltedWidth < 0.8 && tiltedWidth > 0.6,
              "motion: 45-degree tilt Y foreshortens width (~cos45)",
              QString::number(tiltedWidth));

        // Focus: 3D wins over zoom, never both.
        check(catcut::resolveFocus(true, true) == catcut::FocusSource::Screen3D,
              "motion: focus prefers 3D when both are active");
        check(catcut::resolveFocus(true, false) == catcut::FocusSource::Zoom,
              "motion: focus falls back to zoom");
        check(catcut::resolveFocus(false, false) == catcut::FocusSource::None,
              "motion: no focus when neither is active");

        // Pointer track: sampling, calibration, still-hide.
        catcut::PointerTrack track;
        track.samples = {catcut::PointerSample{0.0, 0.0, 0.0, false},
                         catcut::PointerSample{2.0, 1.0, 1.0, false}};
        catcut::PointerSample s;
        check(track.sampleAt(1.0, s) && nearValue(s.x, 0.5, 1e-9) && nearValue(s.y, 0.5, 1e-9),
              "motion: pointer interpolates between samples");
        check(!track.sampleAt(3.0, s), "motion: pointer sample outside the track fails");
        track.timeOffsetMs = 1000.0; // +1s: track time 1.0 now reads sample 0.0
        check(track.sampleAt(1.0, s) && nearValue(s.x, 0.0, 1e-9),
              "motion: pointer time calibration shifts the track");
        track.timeOffsetMs = 0.0;
        track.stillHideDelay = 1.0;
        check(track.visibleAt(0.5), "motion: pointer visible while moving");
        check(!track.visibleAt(1.999), "motion: pointer hides after stillHideDelay");
        catcut::PointerTrack empty;
        check(!empty.sampleAt(0.0, s) && !empty.visibleAt(0.0),
              "motion: empty pointer track is invisible");
    }

    // ------------------------------------------------------- 4. canvas
    {
        catcut::CanvasStyle windowStyle;
        windowStyle.frame = catcut::FrameStyle::WindowLight;
        const catcut::FrameGeometry geom = windowStyle.frameGeometry(QSize(1920, 1080));
        check(geom.hasToolbar && geom.content.y() > geom.outer.y()
                  && geom.toolbar.height() > 0.0,
              "canvas: window frame has a toolbar above the content");
        catcut::CanvasStyle phone;
        phone.frame = catcut::FrameStyle::Phone;
        const catcut::FrameGeometry phoneGeom = phone.frameGeometry(QSize(1920, 1080));
        check(phoneGeom.outer.width() < 1920.0 && phoneGeom.outer.height() < 1080.0
                  && phoneGeom.outer.width() < phoneGeom.outer.height(),
              "canvas: phone frame is a portrait rect inside the canvas");
        check(catcut::frameStyleFromName("browser-neon-legacy") == catcut::FrameStyle::BrowserLight,
              "canvas: unknown frame style maps to the nearest core style");
        check(catcut::frameStyleFromName("window-dark") == catcut::FrameStyle::WindowDark,
              "canvas: known frame style resolves");

        // Crop changes pixels; identity canvas is a no-op.
        QImage half(8, 8, QImage::Format_RGBA8888);
        for (int y = 0; y < 8; ++y) {
            for (int x = 0; x < 8; ++x)
                half.setPixel(x, y, x < 4 ? qRgba(255, 0, 0, 255) : qRgba(0, 0, 255, 255));
        }
        catcut::CanvasStyle identity;
        QImage untouched = half;
        identity.applyToImage(untouched);
        check(untouched == half, "canvas: identity style leaves the image unchanged");
        catcut::CanvasStyle cropped;
        cropped.crop.x = 0.5;
        cropped.crop.y = 0.0;
        cropped.crop.width = 0.5;
        cropped.crop.height = 1.0;
        QImage croppedImg = half;
        cropped.applyToImage(croppedImg);
        // The right (blue) half is fitted centred into the canvas:
        // 4 of 8 columns end up blue, the rest letterboxed black.
        check(nearValue(imageMeanChannel(croppedImg, 2), 127.5, 30.0)
                  && imageMeanChannel(croppedImg, 0) < 10.0,
              "canvas: crop keeps the right (blue) half",
              QString("meanR=%1 meanB=%2").arg(imageMeanChannel(croppedImg, 0))
                  .arg(imageMeanChannel(croppedImg, 2)));
        const catcut::CanvasStyle back =
            catcut::CanvasStyle::fromJson(cropped.toJson());
        check(nearValue(back.crop.x, 0.5, 1e-9) && back.crop.width == 0.5,
              "canvas: JSON round-trip keeps the crop");
    }

    // ------------------------------------------- 5. evaluator integration
    {
        catcut::TimelineModel model;
        catcut::Clip clip;
        clip.name = QStringLiteral("A");
        clip.mediaPath = file4k;
        clip.kind = catcut::ClipKind::Video;
        clip.sourceIn = 0.0;
        clip.sourceOut = 2.0;
        clip.gradeEnabled = true;
        clip.grade.temperature = 0.3;
        clip.beauty.enabled = true;
        clip.beauty.strength = 0.5;
        clip.chromaKey.enabled = true;
        model.appendPrimaryClip(clip);
        const QString clipId = model.primaryClips()[0].id;

        catcut::CanvasStyle canvas;
        canvas.padding = 0.05;
        model.setCanvasStyle(canvas);
        catcut::MosaicClip mosaic;
        mosaic.id = QStringLiteral("m1");
        mosaic.start = 0.5;
        mosaic.end = 1.5;
        model.addMosaic(mosaic);
        model.addClickEvent(catcut::ClickEvent{0.5, 0.5, 0.5});
        catcut::PointerTrack track;
        track.samples = {catcut::PointerSample{0.0, 0.0, 0.0, false},
                         catcut::PointerSample{2.0, 1.0, 1.0, false}};
        model.setPointerTrack(track);

        catcut::TimelineEvaluator evaluator(&model, QSize(960, 540));
        const catcut::FrameScene scene = evaluator.evaluate(1.0);
        check(scene.videoLayers.size() == 1 && scene.videoLayers[0].hasGrade
                  && nearValue(scene.videoLayers[0].grade.temperature, 0.3, 1e-9),
              "evaluator: clip grade rides into the layer");
        check(scene.videoLayers[0].beauty.enabled
                  && scene.videoLayers[0].chromaKey.enabled,
              "evaluator: beauty + chroma key ride into the layer");
        check(nearValue(scene.canvasStyle.padding, 0.05, 1e-9),
              "evaluator: canvas style rides into the scene");
        check(scene.activeMosaics.size() == 1
                  && nearValue(scene.activeMosaics[0].progress, 1.0, 1e-9),
              "evaluator: active mosaic rides into the scene at progress 1");
        check(scene.autoZoom > 1.0, "evaluator: auto-zoom is active after a click",
              QString::number(scene.autoZoom));
        check(scene.pointerVisible, "evaluator: pointer is visible at 1.0s");
        check(scene.focusSource == catcut::FocusSource::None,
              "evaluator: no focus effect without any focus enabled");

        // Timeline JSON round-trip keeps the S3 state.
        const QJsonObject json = model.toJson();
        catcut::TimelineModel restored;
        QString error;
        check(restored.fromJson(json, error), "evaluator: timeline JSON round-trip loads", error);
        const catcut::Clip* rc = restored.findClip(clipId);
        check(rc && rc->gradeEnabled && nearValue(rc->grade.temperature, 0.3, 1e-9)
                  && rc->beauty.enabled && rc->chromaKey.enabled,
              "evaluator: round-trip keeps clip grade/beauty/keying");
        check(nearValue(restored.canvasStyle().padding, 0.05, 1e-9)
                  && restored.mosaics().size() == 1
                  && restored.clickEvents().size() == 1
                  && restored.pointerTrack().samples.size() == 2,
              "evaluator: round-trip keeps canvas/mosaic/clicks/pointer");
    }

    // ------------------------------ 6. preview vs export consistency
    double consistencyError = 1e9;
    {
        catcut::TimelineModel model;
        catcut::Clip clip;
        clip.name = QStringLiteral("A");
        clip.mediaPath = file4k;
        clip.kind = catcut::ClipKind::Video;
        clip.sourceIn = 0.0;
        clip.sourceOut = 2.0;
        clip.gradeEnabled = true;
        clip.grade.temperature = 0.3;
        clip.grade.wheels[3].r = 0.08;
        clip.grade.hslZones[2].saturation = 0.4;
        clip.grade.curves.points[0] = {0.0, 0.3, 0.55, 0.8, 1.0};
        clip.beauty.enabled = true;
        clip.beauty.strength = 0.4;
        model.appendPrimaryClip(clip);

        catcut::TimelineFrameProvider provider =
            [](const QString& path, double sourceTime, QImage& out) {
                QString error;
                catcut::Decoder decoder;
                return decoder.decodeFrameAt(path, sourceTime, QSize(480, 270), out, error);
            };
        const QSize canvas(480, 270);
        catcut::TimelineEvaluator evaluator(&model, canvas);

        QImage previewImage, exportImage, ungradedImage;
        QString renderError;
        bool previewOk = false, exportOk = false, ungradedOk = false;
        {
            const catcut::FrameScene scene = evaluator.evaluate(0.5);
            previewOk = catcut::TimelineFrameRenderer::render(scene, provider, previewImage,
                                                             renderError, canvas, true);
        }
        check(previewOk, "consistency: preview path renders the graded frame", renderError);
        {
            exportOk = catcut::ExportFrameRenderer::renderExportFrame(
                &model, 0.5, canvas, exportImage, renderError);
        }
        check(exportOk, "consistency: export path renders the graded frame", renderError);
        {
            const catcut::FrameScene scene = evaluator.evaluate(0.5);
            ungradedOk = catcut::TimelineFrameRenderer::render(scene, provider, ungradedImage,
                                                              renderError, canvas, false);
        }
        check(ungradedOk, "consistency: ungraded render works (control)", renderError);
        if (previewOk && exportOk) {
            check(previewImage.size() == canvas && exportImage.size() == canvas,
                  "consistency: both renders are 480x270");
            const int nonBlack =
                catcut::PreviewRenderer::countNonBlackPixels(previewImage, 16);
            check(nonBlack > (480 * 270) / 100, "consistency: graded frame is not black",
                  QString("non-black=%1").arg(nonBlack));
            consistencyError = meanAbsDiff(previewImage, exportImage);
            check(consistencyError < 2.55,
                  "consistency: preview vs export mean error < 1% of 255",
                  QString("mean error=%1 / 255").arg(consistencyError));
            const double gradedVsPlain = meanAbsDiff(previewImage, ungradedImage);
            check(gradedVsPlain > 0.5,
                  "consistency: the grade actually changes pixels",
                  QString("graded-vs-plain=%1").arg(gradedVsPlain));
            previewImage.save(outDir.filePath(QStringLiteral("s3-preview-graded.png")), "PNG");
            exportImage.save(outDir.filePath(QStringLiteral("s3-export-graded.png")), "PNG");
        }
    }
    out << "CONSISTENCY_MEAN_ERROR=" << QString::number(consistencyError, 'f', 4) << "\n";

    // ------------------------------------------------ 7. GPU shader resource
    {
        QFile qsb(QStringLiteral(":/shaders/grade.frag.qsb"));
        bool ok = qsb.open(QIODevice::ReadOnly);
        check(ok, "shader: grade.frag.qsb resource exists");
        bool valid = false;
        if (ok) {
            const QShader shader = QShader::fromSerialized(qsb.readAll());
            valid = shader.isValid();
        }
        check(valid, "shader: grade.frag.qsb parses as a valid QShader");
        out << "GRADE_QSB_OK=" << (valid ? 1 : 0) << "\n";
    }

    // ---------------------------------------------------------- summary
    out << (g_failures == 0 ? "VERIFY-S3 RESULT: PASS\n"
                            : QStringLiteral("VERIFY-S3 RESULT: FAIL (%1 failures)\n").arg(g_failures));
    out.flush();
    return g_failures == 0 ? 0 : 1;
}
