// CatCut v2 — S1 media pipeline: decoding.
//
// Hardware first, software fallback, always with a readable reason:
//   1. Try D3D11VA hardware decoding (Windows only).
//   2. If the hardware device cannot be created, or the decoder refuses
//      it, or a hardware frame cannot be read back, fall back to software
//      decoding and record which path was actually used.
//   3. Decoded frames are scaled (swscale) to the requested preview size
//      and returned as RGBA QImages, ready to upload as a GPU texture.
//
// Cloud note (architecture doc section 8): GitHub Actions runners have no
// GPU, so the hardware path can only be compiled + proven to fall back
// correctly there. Real hardware decoding must be verified on a real
// machine. decodePath() reports what actually happened — never claim
// hardware was used when it was not.

#pragma once

#include <QImage>
#include <QSize>
#include <QString>
#include <memory>

namespace catcut {

class Decoder {
public:
    Decoder();
    ~Decoder();

    Decoder(const Decoder&) = delete;
    Decoder& operator=(const Decoder&) = delete;

    // Opens `path` for video decoding. `targetSize` is the preview size
    // frames are scaled to (fit inside, aspect preserved — see
    // PreviewRenderer::fitSize for the caller's size choice).
    // Returns false with a readable `error` on failure.
    bool open(const QString& path, const QSize& targetSize, QString& error);

    // Decodes the next video frame, scaled to the target size, as RGBA.
    // Returns false at end of stream (error stays empty) or on a real
    // error (error filled with a readable reason).
    bool decodeNextFrame(QImage& out, QString& error);

    // Decodes the first video frame. Convenience wrapper over open() +
    // decodeNextFrame() for one-shot use (first-frame preview).
    bool decodeFirstFrame(const QString& path, const QSize& targetSize,
                          QImage& out, QString& error);

    // Decodes the frame at (or just after) `timeSeconds`: seeks to the
    // nearest keyframe at or before the target, then decodes forward
    // until a frame timestamp reaches the target. When seeking is not
    // supported by the container it degrades to sequential decode from
    // the start — the result is the same frame, only slower. Used by
    // the S2 timeline preview (scrub / playhead render) and the
    // verify-s2 render test. Returns false with a readable `error`
    // when no frame can be decoded at all.
    bool decodeFrameAt(const QString& path, double timeSeconds,
                       const QSize& targetSize, QImage& out, QString& error);

    // Presentation time (seconds) of the most recently decoded frame;
    // 0 before the first frame. Invalid timestamps fall back to
    // frameIndex / fps, so this never returns a nonsense value.
    double lastFramePtsSeconds() const;

    // Decodes up to `count` frames. Returns how many were actually
    // decoded (0 at end of stream / on error). Never throws.
    int decodeFrames(int count, QString& error);

    // What actually decoded frames so far: "d3d11va" or "software".
    // Before the first frame it reports the path that will be attempted.
    QString decodePath() const;
    // Longer explanation, e.g. why hardware was not used.
    QString decodePathDetail() const;

    bool isOpen() const;
    void close();

private:
    // allowHardware=false forces the software path (used once after a
    // hardware frame read-back failure so the retry cannot loop back
    // into the same broken hardware path).
    bool openInternal(const QString& path, const QSize& targetSize,
                      QString& error, bool allowHardware);

    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace catcut
