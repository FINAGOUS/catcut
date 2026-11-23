// CatCut v2 — S3 beauty / keying / masks.
//
// Beauty (CatCut W5 lineage, NOT DogSC — DogSC has no beauty): a
// light denoise + slight lift. When a portrait mask is available the
// effect is confined to the person; without a mask the whole frame
// gets the same light treatment — never a hard error (W5's "missing
// mask is a hard error" rule is NOT carried over; it blocked editing
// whenever the segmentation model was absent).
//
// Mutual exclusion (carried over from W5, verified): beauty and
// portrait-background keying cannot be on at the same time — both
// need the portrait mask and they fight over the background.
// validateBeautyVsKeying() reports the conflict; the UI refuses the
// combination with that message.
//
// Mosaic / spotlight (DogSC MosaicClip semantics, behaviour copied,
// code original): defined in SOURCE-picture normalised coordinates so
// it follows camera motion; blur or spotlight only (the old mosaic
// pixel-block style was deliberately retired upstream and is not
// re-added); strength 0..1 (default 0.55), spotlight darken default
// 0.22 (max 0.75), in/out fades default 0.30s each, corner radius
// default 0.08 normalised by the rectangle's short edge.

#pragma once

#include <QImage>
#include <QJsonObject>
#include <QList>
#include <QPointF>
#include <QString>

namespace catcut {

// --- beauty ---------------------------------------------------------
struct BeautySettings {
    bool enabled = false;
    double strength = 0.5; // 0..1, denoise blend
    double brighten = 0.05; // 0..0.2, slight lift (linear add)
    bool isIdentity() const { return !enabled || (strength <= 0.0 && brighten <= 0.0); }
    QJsonObject toJson() const;
    static BeautySettings fromJson(const QJsonObject& o);
};

// Applies beauty to `image` in place. `mask` (optional, same size,
// Format_Grayscale8 or any format — red channel used) confines the
// effect: mask 0 = untouched, 255 = full effect. No mask = whole
// frame lightly treated. Never fails on a null/mismatched mask: a
// mismatched mask is ignored (whole-frame treatment) rather than
// erroring the render.
void applyBeauty(QImage& image, const BeautySettings& settings, const QImage* mask);

// Beauty + portrait-background keying are mutually exclusive.
QString beautyKeyingConflict(const BeautySettings& beauty, bool portraitKeyingEnabled);

// --- chroma key ------------------------------------------------------
struct ChromaKey {
    bool enabled = false;
    // Key colour in 0..1 sRGB.
    double keyR = 0.0, keyG = 1.0, keyB = 0.0; // green screen default
    double tolerance = 0.25; // 0..1, colour distance that still keys out
    double softness = 0.10;  // 0..1, feather band beyond tolerance
    // Alpha (0 = fully keyed out, 1 = kept) for one pixel, 0..1 sRGB.
    double alphaFor(double r, double g, double b) const;
    QJsonObject toJson() const;
    static ChromaKey fromJson(const QJsonObject& o);
};

// Applies the key to `image` in place (premultiplied alpha on the
// keyed-out pixels). Returns false only when the image is null.
bool applyChromaKey(QImage& image, const ChromaKey& key);

// --- shape masks ------------------------------------------------------
enum class MaskShapeKind { Rectangle, Circle, Polygon };
struct MaskShape {
    MaskShapeKind kind = MaskShapeKind::Rectangle;
    // Normalised rect (0..1, top-left origin) for Rectangle/Circle.
    double x = 0.25, y = 0.25, width = 0.5, height = 0.5;
    // Simplified pen path: normalised polygon vertices (3+ for Polygon).
    QList<QPointF> points;
    double feather = 0.0; // 0..1, edge softness as a fraction of the shape size
    bool inverted = false;
    // Coverage 0..1 of normalised point (nx, ny).
    double coverage(double nx, double ny) const;
    QJsonObject toJson() const;
    static MaskShape fromJson(const QJsonObject& o);
};

// Applies the mask to `image` alpha in place (outside = transparent).
void applyMask(QImage& image, const MaskShape& shape);

// --- mosaic / spotlight (DogSC MosaicClip semantics) ------------------
enum class MosaicStyle { Blur, Spotlight };
struct MosaicClip {
    QString id;
    double start = 0.0; // timeline seconds
    double end = 1.0;
    // Source-picture normalised rect (follows camera motion because it
    // is applied to the frame before the zoom/3D transform).
    double x = 0.25, y = 0.25, width = 0.5, height = 0.5;
    MosaicStyle style = MosaicStyle::Blur;
    double strength = 0.55;      // 0..1
    double darken = 0.22;        // spotlight: how much the outside darkens (max 0.75)
    double fadeIn = 0.30;        // seconds
    double fadeOut = 0.30;       // seconds
    double cornerRadius = 0.08;  // normalised by the rect's short edge
    // Effect progress 0..1 at timeline time `t` (0 outside the clip,
    // ramping through the fades). `none` fades are not supported —
    // fade 0 means an instant cut, which is what fade == 0 means here.
    double progressAt(double t) const;
    bool activeAt(double t) const { return t >= start && t < end; }
    QJsonObject toJson() const;
    static MosaicClip fromJson(const QJsonObject& o, bool& ok);
};

// Applies one mosaic clip to `image` (the decoded source frame, in
// source-picture coordinates) at progress 0..1. Blur blurs inside the
// rounded rect; spotlight darkens outside it and keeps the inside
// crisp. Strength scales the blur radius / darken amount.
void applyMosaic(QImage& image, const MosaicClip& clip, double progress);

} // namespace catcut
