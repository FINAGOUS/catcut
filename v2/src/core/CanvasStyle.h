// CatCut v2 — S3 canvas composition (DogSC CanvasStyle semantics,
// behaviour copied from the research notes, code original).
//
// Everything is normalised 0..1, top-left origin. The mockup frame
// (window / browser / phone / tablet) is GEOMETRY, not an image: the
// frame rect, toolbar rect, content rect, inner/outer corner radii
// and colours are computed from the canvas size, so old projects
// keep opening when a style is renamed (unknown styles map to the
// nearest core style on load, same as DogSC).

#pragma once

#include <QColor>
#include <QImage>
#include <QJsonObject>
#include <QRectF>
#include <QString>

namespace catcut {

struct NormalizedCrop {
    double x = 0.0, y = 0.0, width = 1.0, height = 1.0; // 0..1, source picture
    bool isIdentity() const { return x == 0.0 && y == 0.0 && width == 1.0 && height == 1.0; }
    QJsonObject toJson() const;
    static NormalizedCrop fromJson(const QJsonObject& o);
};

enum class FrameStyle {
    None,
    WindowLight,
    WindowDark,
    BrowserLight,
    BrowserDark,
    Phone,  // portrait; PhoneLandscape uses orientation below
    Tablet
};

QString frameStyleName(FrameStyle style);
FrameStyle frameStyleFromName(const QString& name, FrameStyle fallback = FrameStyle::None);

// Geometry computed from a canvas size — no images involved.
struct FrameGeometry {
    QRectF outer;    // whole frame incl. chrome, in canvas pixels
    QRectF content;  // the picture area inside the chrome
    QRectF toolbar;  // title bar / browser bar (empty when None)
    double outerRadius = 0.0;
    double innerRadius = 0.0;
    QColor chromeColour;
    QColor contentColour; // letterbox colour behind the picture
    QString title;        // window title / browser address text
    bool hasToolbar = false;
};

struct CanvasStyle {
    NormalizedCrop crop;      // crops the source picture
    double padding = 0.0;     // 0..0.25, blank margin as a fraction of the short edge
    double contentScale = 1.0;
    double contentX = 0.5, contentY = 0.5; // normalised content centre
    double cornerRadius = 0.0; // pixels at 1080p, scaled by canvas height
    double strokeWidth = 0.0;  // pixels at 1080p
    QColor strokeColour = Qt::white;
    double strokeOpacity = 1.0;
    double shadowStrength = 0.0; // 0..1
    QColor backgroundColour = Qt::black;
    FrameStyle frame = FrameStyle::None;
    bool frameLandscape = false; // phone/tablet orientation
    QString frameTitle = QStringLiteral("CatCut");

    bool isIdentity() const;
    // Frame geometry for a canvas of `canvasSize` pixels.
    FrameGeometry frameGeometry(const QSize& canvasSize) const;
    // Applies the whole canvas treatment to a composited frame in
    // place: crop -> padding -> rounded corners -> stroke -> shadow ->
    // mockup frame chrome. The input is the composited canvas image;
    // the output is the same canvas size (letterboxed with the
    // background colour where the picture no longer covers).
    void applyToImage(QImage& image) const;

    QJsonObject toJson() const;
    static CanvasStyle fromJson(const QJsonObject& o);
};

} // namespace catcut
