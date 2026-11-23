// CatCut v2 — S1 media pipeline: GPU preview entry point (first frame).

#include "media/PreviewRenderer.h"

#include "media/Decoder.h"
#include "media/MediaProbe.h"

#include <algorithm>

namespace catcut {

QSize PreviewRenderer::fitSize(const QSize& source, const QSize& target)
{
    if (source.width() <= 0 || source.height() <= 0 || target.width() <= 0 || target.height() <= 0)
        return target;
    const double scale = std::min(static_cast<double>(target.width()) / source.width(),
                                  static_cast<double>(target.height()) / source.height());
    if (scale >= 1.0)
        return source;
    int w = static_cast<int>(source.width() * scale + 0.5);
    int h = static_cast<int>(source.height() * scale + 0.5);
    if (w <= 0) w = 1;
    if (h <= 0) h = 1;
    return QSize(w, h);
}

bool PreviewRenderer::renderFirstFrame(const QString& path, QImage& out,
                                       const QSize& targetSize, QString& error,
                                       QString& decodePath)
{
    const MediaInfo info = MediaProbe::probe(path);
    if (!info.ok) {
        error = info.error;
        return false;
    }
    if (!info.hasVideo) {
        error = QStringLiteral("没有视频轨，无法预览：%1").arg(path);
        return false;
    }
    const QSize decodeSize = fitSize(QSize(info.width, info.height), targetSize);
    Decoder decoder;
    if (!decoder.decodeFirstFrame(path, decodeSize, out, error))
        return false;
    decodePath = decoder.decodePath();
    return true;
}

bool PreviewRenderer::renderFirstFrameToPng(const QString& path, const QString& pngPath,
                                            const QSize& targetSize, QString& error,
                                            QString& decodePath)
{
    QImage frame;
    if (!renderFirstFrame(path, frame, targetSize, error, decodePath))
        return false;
    if (!frame.save(pngPath, "PNG")) {
        error = QStringLiteral("无法写入预览 PNG：%1").arg(pngPath);
        return false;
    }
    return true;
}

int PreviewRenderer::countNonBlackPixels(const QImage& image, int threshold)
{
    if (image.isNull())
        return 0;
    const QImage rgba = image.format() == QImage::Format_RGBA8888
        ? image : image.convertToFormat(QImage::Format_RGBA8888);
    int count = 0;
    for (int y = 0; y < rgba.height(); ++y) {
        const uint8_t* row = rgba.constScanLine(y);
        const int pixels = rgba.width();
        for (int x = 0; x < pixels; ++x) {
            const uint8_t* px = row + x * 4;
            if (px[0] > threshold || px[1] > threshold || px[2] > threshold)
                ++count;
        }
    }
    return count;
}

} // namespace catcut
