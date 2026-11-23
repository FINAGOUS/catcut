// CatCut v2 — S1 media pipeline: decoding (D3D11VA first, software fallback).

#include "media/Decoder.h"

#include "media/MediaCommon.h"
#include "media/MediaProbe.h"

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/mathematics.h>
#include <libavutil/pixdesc.h>
#include <libavutil/rational.h>
#include <libavutil/time.h>
#include <libswscale/swscale.h>
// NOTE: do NOT include <libavutil/hwcontext_d3d11va.h> here: it pulls in
// <d3d11.h>, whose C++ operator overloads cannot live inside an
// extern "C" block (MSVC C2733). Nothing in this file needs it —
// AV_PIX_FMT_D3D11 comes from pixfmt.h, av_hwdevice_ctx_create from
// hwcontext.h.
}

namespace catcut {

namespace {

// get_format callback: pick the hardware pixel format when the decoder
// offers it, otherwise fall back to the first (software) format.
#ifdef _WIN32
AVPixelFormat getHwFormat(AVCodecContext* /*ctx*/, const AVPixelFormat* pixFmts)
{
    for (const AVPixelFormat* p = pixFmts; *p != AV_PIX_FMT_NONE; ++p) {
        if (*p == AV_PIX_FMT_D3D11)
            return AV_PIX_FMT_D3D11;
    }
    return pixFmts[0];
}
#endif

} // namespace

struct Decoder::Impl {
    AVFormatContext* fmtCtx = nullptr;
    AVCodecContext* codecCtx = nullptr;
    AVStream* videoStream = nullptr;
    int videoStreamIndex = -1;
    AVFrame* frame = nullptr;    // frame straight from the decoder
    AVFrame* swFrame = nullptr;  // hardware frame transferred to system memory
    AVPacket* pkt = nullptr;
    SwsContext* swsCtx = nullptr;
    int swsSrcWidth = 0;
    int swsSrcHeight = 0;
    AVPixelFormat swsSrcFmt = AV_PIX_FMT_NONE;

    QSize targetSize;
    QString path;
    bool openFlag = false;
    bool eofSent = false;        // NULL packet already sent (flush mode)
    bool inputEof = false;       // av_read_frame returned EOF
    bool hwDeviceCreated = false;
    bool sawHwFrame = false;
    bool hwFallbackTried = false; // already re-opened in software once
    QString hwFailReason;
    QString pathDetail;
    double lastPtsSeconds = 0.0; // pts of the most recently decoded frame
    double fps = 30.0;           // from the probe; pts fallback only
    long long frameIndex = 0;

    ~Impl()
    {
        closeAll();
    }

    void closeAll()
    {
        if (swsCtx) { sws_freeContext(swsCtx); swsCtx = nullptr; }
        if (pkt) { av_packet_free(&pkt); pkt = nullptr; }
        if (frame) { av_frame_free(&frame); frame = nullptr; }
        if (swFrame) { av_frame_free(&swFrame); swFrame = nullptr; }
        if (codecCtx) { avcodec_free_context(&codecCtx); codecCtx = nullptr; }
        if (fmtCtx) { avformat_close_input(&fmtCtx); fmtCtx = nullptr; }
        videoStream = nullptr;
        videoStreamIndex = -1;
        openFlag = false;
        eofSent = false;
        inputEof = false;
    }

    QString currentPath() const
    {
        if (hwDeviceCreated && sawHwFrame)
            return QStringLiteral("d3d11va");
        if (hwDeviceCreated && !sawHwFrame)
            return QStringLiteral("software");
        return QStringLiteral("software");
    }
};

Decoder::Decoder()
    : m_impl(std::make_unique<Impl>())
{
}

Decoder::~Decoder() = default;

bool Decoder::isOpen() const
{
    return m_impl->openFlag;
}

QString Decoder::decodePath() const
{
    return m_impl->currentPath();
}

QString Decoder::decodePathDetail() const
{
    return m_impl->pathDetail;
}

double Decoder::lastFramePtsSeconds() const
{
    return m_impl->lastPtsSeconds;
}

void Decoder::close()
{
    m_impl->closeAll();
}

bool Decoder::open(const QString& path, const QSize& targetSize, QString& error)
{
    return openInternal(path, targetSize, error, true);
}

bool Decoder::openInternal(const QString& path, const QSize& targetSize,
                           QString& error, bool allowHardware)
{
    close();
    Impl& im = *m_impl;
    im.path = path;
    im.targetSize = targetSize;
    im.hwDeviceCreated = false;
    im.sawHwFrame = false;
    im.hwFallbackTried = false;
    im.hwFailReason.clear();
    im.pathDetail.clear();

    // Friendly pre-check: a missing/corrupt file gets the probe's readable
    // reason instead of a raw FFmpeg error.
    const MediaInfo info = MediaProbe::probe(path);
    if (!info.ok) {
        error = info.error;
        return false;
    }
    if (!info.hasVideo) {
        error = QStringLiteral("没有视频轨，无法解码：%1").arg(path);
        return false;
    }

    const QByteArray utf8Path = path.toUtf8();
    int ret = avformat_open_input(&im.fmtCtx, utf8Path.constData(), nullptr, nullptr);
    if (ret < 0 || !im.fmtCtx) {
        error = QStringLiteral("打不开文件：%1").arg(avErrorText(ret));
        return false;
    }
    // find_stream_info failure is non-fatal here (probe already validated
    // the file); streams can still be enumerated from the headers.
    avformat_find_stream_info(im.fmtCtx, nullptr);

    im.videoStreamIndex = av_find_best_stream(im.fmtCtx, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (im.videoStreamIndex < 0) {
        error = QStringLiteral("没有找到视频流：%1").arg(path);
        close();
        return false;
    }
    im.videoStream = im.fmtCtx->streams[im.videoStreamIndex];
    const AVCodecParameters* par = im.videoStream->codecpar;

    const AVCodec* decoder = avcodec_find_decoder(static_cast<AVCodecID>(par->codec_id));
    if (!decoder) {
        error = QStringLiteral("缺少解码器：编码 %1 没有可用的解码器（需要安装对应的解码支持）")
                    .arg(info.videoCodec.isEmpty() ? QStringLiteral("未知") : info.videoCodec);
        close();
        return false;
    }

    im.frame = av_frame_alloc();
    im.swFrame = av_frame_alloc();
    im.pkt = av_packet_alloc();
    if (!im.frame || !im.swFrame || !im.pkt) {
        error = QStringLiteral("内存不足：无法分配解码缓冲");
        close();
        return false;
    }

    // --- Try hardware first (Windows/D3D11VA), unless the caller forced
    // software (after a hardware frame read-back failure). Any failure
    // here falls through to the software path below; nothing throws. ---
#ifdef _WIN32
    if (!allowHardware) {
        im.hwFailReason = QStringLiteral("硬件帧回读失败，已强制使用软解");
    } else {
    AVBufferRef* hwDevice = nullptr;
    ret = av_hwdevice_ctx_create(&hwDevice, AV_HWDEVICE_TYPE_D3D11VA, nullptr, nullptr, 0);
    if (ret == 0 && hwDevice) {
        im.codecCtx = avcodec_alloc_context3(decoder);
        if (!im.codecCtx) {
            av_buffer_unref(&hwDevice);
            error = QStringLiteral("内存不足：无法分配解码器上下文");
            close();
            return false;
        }
        if (avcodec_parameters_to_context(im.codecCtx, par) < 0) {
            av_buffer_unref(&hwDevice);
            error = QStringLiteral("无法应用流参数（编码 %1）").arg(info.videoCodec);
            close();
            return false;
        }
        im.codecCtx->hw_device_ctx = av_buffer_ref(hwDevice);
        av_buffer_unref(&hwDevice);
        im.codecCtx->get_format = getHwFormat;
        ret = avcodec_open2(im.codecCtx, decoder, nullptr);
        if (ret == 0) {
            im.hwDeviceCreated = true;
            im.pathDetail = QStringLiteral("D3D11VA 硬件解码已建立（编码 %1）").arg(info.videoCodec);
        } else {
            // Hardware open failed: drop the hardware context and retry
            // in software. This is the normal path on machines without a
            // usable GPU (including cloud runners).
            im.hwFailReason = avErrorText(ret);
            avcodec_free_context(&im.codecCtx);
        }
    } else {
        im.hwFailReason = avErrorText(ret);
    }
    } // else (allowHardware)
#else
    Q_UNUSED(allowHardware);
    im.hwFailReason = QStringLiteral("当前平台无硬件解码后端，使用软解");
#endif

    if (!im.codecCtx) {
        im.codecCtx = avcodec_alloc_context3(decoder);
        if (!im.codecCtx) {
            error = QStringLiteral("内存不足：无法分配解码器上下文");
            close();
            return false;
        }
        if (avcodec_parameters_to_context(im.codecCtx, par) < 0) {
            error = QStringLiteral("无法应用流参数（编码 %1）").arg(info.videoCodec);
            close();
            return false;
        }
        ret = avcodec_open2(im.codecCtx, decoder, nullptr);
        if (ret < 0) {
            error = QStringLiteral("解码器打开失败（编码 %1）：%2").arg(info.videoCodec, avErrorText(ret));
            close();
            return false;
        }
        if (im.hwDeviceCreated) {
            im.pathDetail = QStringLiteral("硬件解码打开失败（%1），已回退软解").arg(im.hwFailReason);
        } else if (!im.hwFailReason.isEmpty()) {
            im.pathDetail = QStringLiteral("软解（硬件解码不可用：%1）").arg(im.hwFailReason);
        } else {
            im.pathDetail = QStringLiteral("软解");
        }
    }

    im.openFlag = true;
    im.fps = info.fps > 0.0 ? info.fps : 30.0;
    im.frameIndex = 0;
    im.lastPtsSeconds = 0.0;
    return true;
}

// Re-opens the decoder in pure software mode and seeks back to the start.
// (Implemented inline in decodeNextFrame via close() + open().)

bool Decoder::decodeNextFrame(QImage& out, QString& error)
{
    Impl& im = *m_impl;
    if (!im.openFlag) {
        error = QStringLiteral("解码器未打开");
        return false;
    }

    while (true) {
        int ret = avcodec_receive_frame(im.codecCtx, im.frame);
        if (ret == 0) {
            // Presentation time of this frame, for decodeFrameAt().
            // best_effort_timestamp is the decoder's own best guess;
            // when the stream carries no timestamps, fall back to the
            // frame index over the probed fps.
            const int64_t pts = im.frame->best_effort_timestamp;
            if (pts != AV_NOPTS_VALUE && im.videoStream)
                im.lastPtsSeconds = static_cast<double>(pts) * av_q2d(im.videoStream->time_base);
            else
                im.lastPtsSeconds = static_cast<double>(im.frameIndex) / im.fps;
            ++im.frameIndex;
            // If the hardware device was created but the decoder hands
            // back software frames, say so — decodePath() already
            // reports "software", the detail must not claim otherwise.
            if (im.hwDeviceCreated && !im.sawHwFrame
                && im.frame->format != AV_PIX_FMT_D3D11
                && im.pathDetail.contains(QStringLiteral("已建立"))
                && !im.pathDetail.contains(QStringLiteral("实际出软解帧"))) {
                im.pathDetail += QStringLiteral("，实际出软解帧");
            }
            // Got a frame. Hardware frames must be transferred to system
            // memory before swscale can touch them.
            AVFrame* src = im.frame;
            if (im.frame->format == AV_PIX_FMT_D3D11) {
                im.sawHwFrame = true;
                ret = av_hwframe_transfer_data(im.swFrame, im.frame, 0);
                if (ret < 0) {
                    if (!im.hwFallbackTried) {
                        // One-time fallback: re-open in software from the
                        // start and keep decoding. The caller just sees
                        // frames; the path change is recorded. Forced
                        // software so the retry cannot loop back into the
                        // same broken hardware path.
                        im.hwFallbackTried = true;
                        im.hwFailReason = QStringLiteral("硬件帧回读失败：%1").arg(avErrorText(ret));
                        const QString p = im.path;
                        const QSize ts = im.targetSize;
                        QString reopenError;
                        close();
                        if (!openInternal(p, ts, reopenError, false)) {
                            error = QStringLiteral("硬件帧回读失败，且软解重开失败：%1").arg(reopenError);
                            return false;
                        }
                        im.pathDetail = QStringLiteral("硬件帧回读失败（%1），已回退软解").arg(im.hwFailReason);
                        continue;
                    }
                    error = QStringLiteral("硬件帧回读失败：%1").arg(avErrorText(ret));
                    return false;
                }
                src = im.swFrame;
            }

            // Scale to the preview target size (full decode + swscale;
            // resolution-limited decode via lowres is not supported by
            // H.264/VP9/HEVC decoders, so scaling after decode is the
            // honest implementation — see the encoding matrix doc).
            const int dstW = im.targetSize.width();
            const int dstH = im.targetSize.height();
            if (!im.swsCtx || im.swsSrcWidth != src->width || im.swsSrcHeight != src->height
                || im.swsSrcFmt != static_cast<AVPixelFormat>(src->format)) {
                sws_freeContext(im.swsCtx);
                im.swsCtx = sws_getContext(src->width, src->height, static_cast<AVPixelFormat>(src->format),
                                           dstW, dstH, AV_PIX_FMT_RGBA, SWS_BILINEAR,
                                           nullptr, nullptr, nullptr);
                im.swsSrcWidth = src->width;
                im.swsSrcHeight = src->height;
                im.swsSrcFmt = static_cast<AVPixelFormat>(src->format);
            }
            if (!im.swsCtx) {
                error = QStringLiteral("无法创建缩放器（%1x%2 → %3x%4）")
                            .arg(src->width).arg(src->height).arg(dstW).arg(dstH);
                return false;
            }
            QImage image(dstW, dstH, QImage::Format_RGBA8888);
            if (image.isNull()) {
                error = QStringLiteral("内存不足：无法分配 %1x%2 预览帧").arg(dstW).arg(dstH);
                return false;
            }
            uint8_t* dstData[4] = { image.bits(), nullptr, nullptr, nullptr };
            int dstLinesize[4] = { static_cast<int>(image.bytesPerLine()), 0, 0, 0 };
            sws_scale(im.swsCtx, src->data, src->linesize, 0, src->height, dstData, dstLinesize);
            out = image;
            return true;
        }
        if (ret == AVERROR(EAGAIN)) {
            if (im.inputEof) {
                if (!im.eofSent) {
                    im.eofSent = true;
                    avcodec_send_packet(im.codecCtx, nullptr); // flush
                    continue;
                }
                return false; // drained
            }
            ret = av_read_frame(im.fmtCtx, im.pkt);
            if (ret < 0) {
                im.inputEof = true;
                continue;
            }
            if (im.pkt->stream_index != im.videoStreamIndex) {
                av_packet_unref(im.pkt);
                continue;
            }
            ret = avcodec_send_packet(im.codecCtx, im.pkt);
            av_packet_unref(im.pkt);
            if (ret < 0 && ret != AVERROR(EAGAIN)) {
                error = QStringLiteral("送包给解码器失败：%1").arg(avErrorText(ret));
                return false;
            }
            continue;
        }
        if (ret == AVERROR_EOF) {
            return false; // end of stream
        }
        error = QStringLiteral("解码失败：%1").arg(avErrorText(ret));
        return false;
    }
}

bool Decoder::decodeFirstFrame(const QString& path, const QSize& targetSize,
                               QImage& out, QString& error)
{
    if (!open(path, targetSize, error))
        return false;
    if (!decodeNextFrame(out, error)) {
        if (error.isEmpty())
            error = QStringLiteral("文件中没有可解码的视频帧（文件可能已损坏或只有音频）");
        close();
        return false;
    }
    return true;
}

bool Decoder::decodeFrameAt(const QString& path, double timeSeconds,
                            const QSize& targetSize, QImage& out, QString& error)
{
    if (!open(path, targetSize, error))
        return false;
    Impl& im = *m_impl;
    if (timeSeconds > 0.0 && im.videoStream) {
        const int64_t ts = av_rescale_q(
            static_cast<int64_t>(timeSeconds * 1000000.0), AV_TIME_BASE_Q,
            im.videoStream->time_base);
        if (av_seek_frame(im.fmtCtx, im.videoStreamIndex, ts, AVSEEK_FLAG_BACKWARD) >= 0)
            avcodec_flush_buffers(im.codecCtx);
        // Seek failure: fall through to sequential decode from the
        // start — same frame, only slower.
    }
    QImage last;
    bool gotFrame = false;
    while (true) {
        QImage image;
        QString decodeError;
        if (!decodeNextFrame(image, decodeError))
            break;
        last = image;
        gotFrame = true;
        if (im.lastPtsSeconds >= timeSeconds - 1e-6)
            break;
    }
    if (!gotFrame) {
        error = QStringLiteral("在 %1s 处没有可解码的视频帧").arg(timeSeconds, 0, 'f', 2);
        close();
        return false;
    }
    out = last;
    return true;
}

int Decoder::decodeFrames(int count, QString& error)
{
    int decoded = 0;
    for (int i = 0; i < count; ++i) {
        QImage frame;
        if (!decodeNextFrame(frame, error))
            break;
        ++decoded;
    }
    return decoded;
}

} // namespace catcut
