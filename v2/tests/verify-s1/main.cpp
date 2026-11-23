// CatCut v2 — S1 self-test (verify-s1).
//
// Usage: verify-s1 <probe-dir> <output-dir>
//   probe-dir : test_8k.mp4, test_4k.mp4, test_corrupt.mp4 (generated in
//               the workflow by the bundled ffmpeg.exe, see v2-build.yml)
//   output-dir: receives the proxy + the first-frame PNG.
//
// Checks (exit 0 = all passed):
//   1. probe: normal 8K + 4K files (container/codec/size/fps/duration)
//   2. probe: missing file + corrupt file fail gracefully with a readable
//      reason (no crash, no unhandled exception)
//   3. decode: first N frames of 8K and 4K, recording whether the path
//      was hardware (d3d11va) or software fallback. Cloud runners have
//      no GPU, so "software" is the expected result there — the check is
//      that decoding works and the path is reported honestly.
//   4. proxy: 720p proxy of the 4K file exists, is 1280x720, and its
//      duration matches the source; the encoder actually selected is
//      printed (libopenh264 -> libvpx-vp9 -> mpeg4).
//   5. preview: offscreen first-frame render to PNG (no display server;
//      run with QT_QPA_PLATFORM=offscreen), correct size, non-black.
//
// Machine-readable lines for the run log:
//   DECODE_PATH=<d3d11va|software>  PROXY_ENCODER=<name>

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QGuiApplication>
#include <QImage>
#include <QTextStream>

#include <cmath>
#include <iostream>

#include "media/Decoder.h"
#include "media/MediaCommon.h"
#include "media/MediaProbe.h"
#include "media/PreviewRenderer.h"
#include "media/ProxyJob.h"

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

} // namespace

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);

    QTextStream out(stdout);
    out << "verify-s1: CatCut v2 S1 media pipeline self-test\n";
    out << "ffmpeg: " << catcut::ffmpegVersionString() << "\n";
    out << "Qt: " << qVersion() << "\n";
    out.flush();

    if (argc < 3) {
        out << "usage: verify-s1 <probe-dir> <output-dir>\n";
        return 2;
    }
    const QDir probeDir(QString::fromLocal8Bit(argv[1]));
    const QDir outDir(QString::fromLocal8Bit(argv[2]));
    if (!outDir.exists())
        QDir().mkpath(outDir.absolutePath());

    const QString file8k = probeDir.filePath(QStringLiteral("test_8k.mp4"));
    const QString file4k = probeDir.filePath(QStringLiteral("test_4k.mp4"));
    const QString fileCorrupt = probeDir.filePath(QStringLiteral("test_corrupt.mp4"));
    const QString fileMissing = probeDir.filePath(QStringLiteral("does-not-exist.mp4"));

    // ---------------------------------------------------------- 1. probe
    const catcut::MediaInfo info8k = catcut::MediaProbe::probe(file8k);
    check(info8k.ok, QStringLiteral("probe 8K file"),
          catcut::MediaProbe::describe(info8k));
    check(info8k.width == 7680 && info8k.height == 4320,
          QStringLiteral("probe 8K size is 7680x4320"),
          QStringLiteral("%1x%2").arg(info8k.width).arg(info8k.height));
    check(nearValue(info8k.fps, 30.0, 1.0), QStringLiteral("probe 8K fps ~30"),
          QStringLiteral("%1").arg(info8k.fps));
    check(nearValue(info8k.durationSeconds, 5.0, 1.0), QStringLiteral("probe 8K duration ~5s"),
          QStringLiteral("%1").arg(info8k.durationSeconds));

    const catcut::MediaInfo info4k = catcut::MediaProbe::probe(file4k);
    check(info4k.ok, QStringLiteral("probe 4K file"),
          catcut::MediaProbe::describe(info4k));
    check(info4k.width == 3840 && info4k.height == 2160,
          QStringLiteral("probe 4K size is 3840x2160"),
          QStringLiteral("%1x%2").arg(info4k.width).arg(info4k.height));
    check(nearValue(info4k.durationSeconds, 5.0, 1.0), QStringLiteral("probe 4K duration ~5s"),
          QStringLiteral("%1").arg(info4k.durationSeconds));

    // ------------------------------------------------- 2. probe failures
    const catcut::MediaInfo infoMissing = catcut::MediaProbe::probe(fileMissing);
    check(!infoMissing.ok && !infoMissing.error.isEmpty(),
          QStringLiteral("probe missing file fails gracefully"), infoMissing.error);

    const catcut::MediaInfo infoCorrupt = catcut::MediaProbe::probe(fileCorrupt);
    check(!infoCorrupt.ok && !infoCorrupt.error.isEmpty(),
          QStringLiteral("probe corrupt file fails gracefully"), infoCorrupt.error);

    // --------------------------------------------------------- 3. decode
    QString decodeError;
    catcut::Decoder decoder8k;
    const int decoded8k = [&]() {
        if (!decoder8k.open(file8k, QSize(960, 540), decodeError))
            return 0;
        return decoder8k.decodeFrames(3, decodeError);
    }();
    check(decoded8k >= 3, QStringLiteral("decode 3 frames of 8K"),
          QStringLiteral("decoded=%1 path=%2 (%3) err=%4")
              .arg(decoded8k, decoder8k.decodePath(), decoder8k.decodePathDetail(), decodeError));
    out << "DECODE_PATH_8K=" << decoder8k.decodePath() << "\n";
    out.flush();

    catcut::Decoder decoder4k;
    decodeError.clear();
    const int decoded4k = [&]() {
        if (!decoder4k.open(file4k, QSize(960, 540), decodeError))
            return 0;
        return decoder4k.decodeFrames(10, decodeError);
    }();
    check(decoded4k >= 10, QStringLiteral("decode 10 frames of 4K"),
          QStringLiteral("decoded=%1 path=%2 (%3) err=%4")
              .arg(decoded4k, decoder4k.decodePath(), decoder4k.decodePathDetail(), decodeError));
    out << "DECODE_PATH=" << decoder4k.decodePath() << "\n";
    out.flush();
    // Cloud runners have no GPU: the honest expectation is the software
    // fallback. If hardware ever reports here, that is fine too — the
    // check is that the path is one of the two known values.
    check(decoder4k.decodePath() == QLatin1String("software")
              || decoder4k.decodePath() == QLatin1String("d3d11va"),
          QStringLiteral("decode path is a known value"), decoder4k.decodePath());

    // ---------------------------------------------------------- 4. proxy
    const QString proxyEncoder = catcut::ProxyJob::selectEncoder();
    out << "PROXY_ENCODER=" << proxyEncoder << "\n";
    out.flush();
    check(!proxyEncoder.isEmpty(), QStringLiteral("a proxy encoder is available"), proxyEncoder);

    const QString proxyPath = outDir.filePath(QStringLiteral("proxy-4k.mp4"));
    QString proxyError;
    QString proxyEncoderUsed;
    catcut::ProxyJob proxyJob;
    const bool proxyOk = proxyJob.generate(file4k, proxyPath, 720, proxyError, proxyEncoderUsed);
    check(proxyOk, QStringLiteral("proxy generation (720p)"),
          proxyOk ? QStringLiteral("encoder=%1").arg(proxyEncoderUsed) : proxyError);
    out << "PROXY_ENCODER_USED=" << proxyEncoderUsed << "\n";
    out.flush();

    const QFileInfo proxyFileInfo(proxyPath);
    check(proxyFileInfo.exists() && proxyFileInfo.size() > 0,
          QStringLiteral("proxy file exists and is non-empty"),
          QStringLiteral("%1 bytes").arg(proxyFileInfo.size()));
    const catcut::MediaInfo proxyInfo = catcut::MediaProbe::probe(proxyPath);
    check(proxyInfo.ok && proxyInfo.width == 1280 && proxyInfo.height == 720,
          QStringLiteral("proxy is 1280x720"),
          QStringLiteral("%1x%2").arg(proxyInfo.width).arg(proxyInfo.height));
    check(proxyInfo.ok && nearValue(proxyInfo.durationSeconds, info4k.durationSeconds, 1.0),
          QStringLiteral("proxy duration matches source"),
          QStringLiteral("proxy=%1s source=%2s")
              .arg(proxyInfo.durationSeconds).arg(info4k.durationSeconds));

    // --------------------------------------------------------- 5. preview
    const QString pngPath = outDir.filePath(QStringLiteral("first-frame.png"));
    QString previewError;
    QString previewDecodePath;
    const bool previewOk = catcut::PreviewRenderer::renderFirstFrameToPng(
        file4k, pngPath, QSize(960, 540), previewError, previewDecodePath);
    check(previewOk, QStringLiteral("offscreen first-frame render to PNG"),
          previewOk ? QStringLiteral("decodePath=%1").arg(previewDecodePath) : previewError);

    QImage png(pngPath);
    check(!png.isNull() && png.width() == 960 && png.height() == 540,
          QStringLiteral("first-frame PNG is 960x540"),
          QStringLiteral("%1x%2").arg(png.width()).arg(png.height()));
    const int nonBlack = catcut::PreviewRenderer::countNonBlackPixels(png, 16);
    check(nonBlack > (960 * 540) / 100,
          QStringLiteral("first-frame PNG is not black"),
          QStringLiteral("non-black pixels=%1 of %2").arg(nonBlack).arg(960 * 540));

    // ---------------------------------------------------------- summary
    out << (g_failures == 0 ? "VERIFY-S1 RESULT: PASS\n"
                            : QStringLiteral("VERIFY-S1 RESULT: FAIL (%1 failures)\n").arg(g_failures));
    out.flush();
    return g_failures == 0 ? 0 : 1;
}
