// CatCut v2 — S3 colour: the grade model + the fixed ordered chain.
//
// Chain order (fixed, FCP-style; the GLSL in shaders/grade.frag
// implements exactly these steps in this order — see docs/s3):
//   input conversion -> white balance -> HSL zones -> colour wheels
//   -> RGB curves -> .cube LUT -> output conversion
//
// Working space is 0..1 floats. Input conversion is sRGB -> linear
// approximated as pow(c, 2.2); output is the inverse pow(c, 1/2.2).
// An identity grade therefore round-trips exactly (up to float error),
// which the verify-s3 tests pin down.
//
// GPU vs lut3d decision (recorded here because it shapes this file):
// the grade runs in a QRhi fragment shader (grade.frag), NOT through
// FFmpeg lut3d. lut3d would need a fresh 17^3 LUT baked on the CPU
// for every slider tick (quantisation + rebuild cost), cannot express
// the HSL-zone weights or the per-zone wheel weights without baking,
// and cannot share one path with the scopes/beauty/mask stages. The
// shader takes the parameters as uniforms + two small textures (curve
// table, packed .cube LUT), so a slider move is a uniform update, not
// a rebuild. This file is the CPU reference implementation of the
// identical math: TimelineFrameRenderer (the one shared preview/export
// path) grades through here, and verify-s3 proves the CPU path
// against analytic expectations. Live-preview GPU parity is a real-
// machine check (CI runners have no GPU); the shader source mirrors
// this file step for step, same constants, same order.

#pragma once

#include <QImage>
#include <QJsonObject>
#include <QString>
#include <QVector>
#include <array>

namespace catcut {

// One colour wheel: additive RGB offsets, each -1..1.
struct ColorWheel {
    double r = 0.0;
    double g = 0.0;
    double b = 0.0;
    bool isIdentity() const { return r == 0.0 && g == 0.0 && b == 0.0; }
};

// One HSL zone (7 zones, hue centres in turns, see ColorGrade::kZoneHues).
// hueShift in turns (-0.5..0.5); saturation is a delta multiplier
// (-1..1, applied as sat *= 1 + delta); lightness is an additive
// delta (-1..1).
struct HslZone {
    double hueShift = 0.0;
    double saturation = 0.0;
    double lightness = 0.0;
    bool isIdentity() const { return hueShift == 0.0 && saturation == 0.0 && lightness == 0.0; }
};

// RGB / luminance curves: 5 control points per channel at fixed
// x = 0, 0.25, 0.5, 0.75, 1. The 256-entry lookup tables built from
// them are what BOTH the CPU path and the GPU shader sample, so the
// two can never drift apart on curve interpolation.
struct RgbCurves {
    // channels: 0 = master, 1 = R, 2 = G, 3 = B.
    std::array<std::array<double, 5>, 4> points{};
    RgbCurves();
    bool isIdentity() const;
    // 4 x 256 float tables (row-major: channel * 256 + index).
    std::array<float, 1024> buildTable() const;
    QJsonObject toJson() const;
    static RgbCurves fromJson(const QJsonObject& o);
};

// Parsed .cube LUT (Adobe Cube format). Data is size^3 RGB triples,
// index = (r + g*size + b*size*size) * 3, matching the file order.
struct CubeLut {
    int size = 0; // LUT_3D_SIZE, 0 = no LUT loaded
    QVector<float> data;
    float domainMin[3] = {0.0f, 0.0f, 0.0f};
    float domainMax[3] = {1.0f, 1.0f, 1.0f};
    QString title;
    QString sourcePath;
    bool isValid() const { return size >= 2 && data.size() == size * size * size * 3; }
    // Trilinear sample in 0..1 space (domain applied inside).
    void sample(float r, float g, float b, float& outR, float& outG, float& outB) const;
};

// Parses .cube text. Returns false with a readable `error` on any
// problem (bad size, short data, non-numeric line) — never throws,
// never silently returns a half LUT.
bool parseCubeLut(const QString& text, CubeLut& out, QString& error);
bool loadCubeLutFile(const QString& path, CubeLut& out, QString& error);

class ColorGrade {
public:
    // HSL zone hue centres, in turns (0 = red). Zone order:
    // red, orange, yellow, green, cyan, blue, magenta.
    static constexpr double kZoneHues[7] = {0.0, 1.0 / 12.0, 2.0 / 12.0, 4.0 / 12.0,
                                            6.0 / 12.0, 8.0 / 12.0, 10.0 / 12.0};
    static constexpr double kZoneHalfWidth = 1.0 / 12.0; // triangular falloff

    double temperature = 0.0; // -1..1 (warm +)
    double tint = 0.0;        // -1..1 (green +)
    std::array<HslZone, 7> hslZones{};
    ColorWheel wheels[4]; // 0 shadows, 1 midtones, 2 highlights, 3 global
    RgbCurves curves;
    CubeLut lut;           // valid only when lutEnabled
    bool lutEnabled = false;

    bool isIdentity() const;

    // One pixel through the full fixed chain. Inputs/outputs in 0..1.
    // The curve table is passed in so callers build it once per frame
    // (and so the GPU path can use the same table).
    void applyPixel(float r, float g, float b, float& outR, float& outG, float& outB,
                    const std::array<float, 1024>& curveTable) const;
    void applyPixel(float r, float g, float b, float& outR, float& outG, float& outB) const;

    // Whole image (converted to RGBA8888 in place when needed; alpha kept).
    void applyToImage(QImage& image) const;

    // --- helpers, exposed so the GLSL mirror and the tests share them ---
    static void rgbToHsl(float r, float g, float b, float& h, float& s, float& l);
    static void hslToRgb(float h, float s, float l, float& r, float& g, float& b);
    // Triangular zone weight for a hue (turns) against zone `zone`.
    static double zoneWeight(double hueTurns, int zone);
    // Sample one 256-entry curve table row (linear between entries).
    static float sampleCurveTable(const std::array<float, 1024>& table, int channel, float x);

    QJsonObject toJson() const;
    static ColorGrade fromJson(const QJsonObject& o);
};

// --- scopes (analysis of a graded frame; CPU, shown beside the inspector) ---
struct ColorScopes {
    int histR[256] = {};
    int histG[256] = {};
    int histB[256] = {};
    int histLuma[256] = {};
    // Waveform: 256 columns, per-column min/max luma in 0..1.
    float waveMin[256];
    float waveMax[256];
    // Vectorscope: 128x128 grid of (x = B-Y, y = R-Y) sample counts.
    float vectorGrid[128 * 128] = {};
    int pixelCount = 0;
    ColorScopes();
    // Computes all three scopes from `image` (any format; RGBA8888 used).
    static ColorScopes compute(const QImage& image);
    int histTotal() const; // == pixelCount when the image is non-empty
};

} // namespace catcut
