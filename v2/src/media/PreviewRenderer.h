// CatCut v2 — S1 media pipeline: GPU preview entry point.
//
// Two paths, one source of frames:
//   * PreviewRenderer::renderFirstFrame — decodes the first frame and
//     returns it as a QImage (used by the self-test for offscreen
//     rendering, and by the UI to feed the QRhiWidget).
//   * PreviewWidget (ui/PreviewWidget) — uploads that QImage as an RHI
//     texture and draws it with a textured quad.
// Preview decodes at monitor size only (fit inside the target size);
// full-resolution decode + swscale down is what the Decoder does, since
// H.264/VP9/HEVC decoders do not offer resolution-limited decode.

#pragma once

#include <QImage>
#include <QSize>
#include <QString>

namespace catcut {

class PreviewRenderer {
public:
    // Decodes the first frame of `path`, scaled to fit inside
    // `targetSize` keeping aspect ratio. `decodePath` reports whether
    // the frame came from the hardware or the software path.
    static bool renderFirstFrame(const QString& path, QImage& out,
                                 const QSize& targetSize, QString& error,
                                 QString& decodePath);

    // Same, but also writes the frame to `pngPath` (self-test use).
    static bool renderFirstFrameToPng(const QString& path, const QString& pngPath,
                                      const QSize& targetSize, QString& error,
                                      QString& decodePath);

    // Counts pixels where any channel exceeds `threshold` — the self-test
    // uses it to prove the rendered frame is not black.
    static int countNonBlackPixels(const QImage& image, int threshold = 16);

    // Fits `source` inside `target` keeping aspect ratio (never upscales
    // beyond the source, never returns a zero dimension).
    static QSize fitSize(const QSize& source, const QSize& target);
};

} // namespace catcut
