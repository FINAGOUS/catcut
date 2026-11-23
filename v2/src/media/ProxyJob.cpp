// CatCut v2 — S1 media pipeline: background proxy generation (software
// decode -> scale -> software encode; preview only, never for export).

#include "media/ProxyJob.h"

#include "media/MediaCommon.h"
#include "media/MediaProbe.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/rational.h>
#include <libswscale/swscale.h>
}

namespace catcut {

namespace {

// Sends a frame to the encoder and drains all packets it produces.
bool drainEncoder(AVCodecContext* encCtx, AVStream* outStream, AVFormatContext* outCtx,
                  AVFrame* frame, AVPacket* pkt, QString& error)
{
    int ret = avcodec_send_frame(encCtx, frame);
    if (ret < 0) {
        error = QStringLiteral("代理编码送帧失败：%1").arg(avErrorText(ret));
        return false;
    }
    while (true) {
        ret = avcodec_receive_packet(encCtx, pkt);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            av_packet_unref(pkt);
            return true;
        }
        if (ret < 0) {
            error = QStringLiteral("代理编码取包失败：%1").arg(avErrorText(ret));
            return false;
        }
        av_packet_rescale_ts(pkt, encCtx->time_base, outStream->time_base);
        pkt->stream_index = outStream->index;
        ret = av_interleaved_write_frame(outCtx, pkt);
        av_packet_unref(pkt);
        if (ret < 0) {
            error = QStringLiteral("代理写入失败：%1").arg(avErrorText(ret));
            return false;
        }
    }
}

} // namespace

ProxyJob::ProxyJob() = default;

ProxyJob::~ProxyJob()
{
    wait();
}

void ProxyJob::wait()
{
    if (m_thread.joinable())
        m_thread.join();
}

bool ProxyJob::encoderAvailable(const QString& name)
{
    const QByteArray utf8Name = name.toUtf8();
    return avcodec_find_encoder_by_name(utf8Name.constData()) != nullptr;
}

QString ProxyJob::selectEncoder()
{
    // Order fixed by the S1 task: libopenh264 -> libvpx-vp9 -> mpeg4.
    // libx264/libx265 are GPL and never appear in this list.
    static const char* kCandidates[] = { "libopenh264", "libvpx-vp9", "mpeg4" };
    for (const char* candidate : kCandidates) {
        if (avcodec_find_encoder_by_name(candidate))
            return QString::fromLatin1(candidate);
    }
    return QString();
}

void ProxyJob::startAsync(const QString& sourcePath, const QString& proxyPath,
                          int targetHeight, const FinishedCallback& finished,
                          const ProgressCallback& progress)
{
    wait(); // a job object runs one generation at a time
    m_running.store(true);
    m_thread = std::thread([=]() {
        QString error;
        QString encoderUsed;
        const bool ok = generate(sourcePath, proxyPath, targetHeight, error, encoderUsed, progress);
        m_running.store(false);
        if (finished)
            finished(ok, error, encoderUsed);
    });
}

bool ProxyJob::generate(const QString& sourcePath, const QString& proxyPath,
                        int targetHeight, QString& error, QString& encoderUsed,
                        const ProgressCallback& progress)
{
    encoderUsed.clear();

    const MediaInfo info = MediaProbe::probe(sourcePath);
    if (!info.ok) {
        error = QStringLiteral("无法生成代理：%1").arg(info.error);
        return false;
    }
    if (!info.hasVideo || info.width <= 0 || info.height <= 0) {
        error = QStringLiteral("无法生成代理：没有视频轨");
        return false;
    }

    // Target size: keep aspect, never upscale, even dimensions only.
    int dstH = targetHeight;
    if (dstH > info.height)
        dstH = info.height;
    dstH &= ~1;
    int dstW = (info.width * dstH / info.height) & ~1;
    if (dstW <= 0 || dstH <= 0) {
        error = QStringLiteral("无法生成代理：目标尺寸无效（源 %1x%2）").arg(info.width).arg(info.height);
        return false;
    }

    const QString encoderName = selectEncoder();
    if (encoderName.isEmpty()) {
        error = QStringLiteral("没有可用的代理编码器（libopenh264 / libvpx-vp9 / mpeg4 均不可用）");
        return false;
    }
    const AVCodec* encoder = avcodec_find_encoder_by_name(encoderName.toUtf8().constData());
    if (!encoder) {
        error = QStringLiteral("代理编码器 %1 不可用").arg(encoderName);
        return false;
    }

    const double fps = info.fps > 0.0 ? info.fps : 30.0;
    const int totalFrames = (info.durationSeconds > 0.0)
        ? static_cast<int>(info.durationSeconds * fps + 0.5) : 0;

    // --- Open input (software decode; proxies do not need hardware). ---
    AVFormatContext* inCtx = nullptr;
    const QByteArray inPath = sourcePath.toUtf8();
    int ret = avformat_open_input(&inCtx, inPath.constData(), nullptr, nullptr);
    if (ret < 0 || !inCtx) {
        error = QStringLiteral("打不开源文件：%1").arg(avErrorText(ret));
        return false;
    }
    avformat_find_stream_info(inCtx, nullptr);
    const int videoIndex = av_find_best_stream(inCtx, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (videoIndex < 0) {
        error = QStringLiteral("没有找到视频流");
        avformat_close_input(&inCtx);
        return false;
    }
    AVStream* inStream = inCtx->streams[videoIndex];
    const AVCodecParameters* inPar = inStream->codecpar;
    const AVCodec* decoder = avcodec_find_decoder(static_cast<AVCodecID>(inPar->codec_id));
    if (!decoder) {
        error = QStringLiteral("缺少解码器：编码 %1 没有可用的解码器").arg(info.videoCodec);
        avformat_close_input(&inCtx);
        return false;
    }
    AVCodecContext* decCtx = avcodec_alloc_context3(decoder);
    if (!decCtx || avcodec_parameters_to_context(decCtx, inPar) < 0
        || avcodec_open2(decCtx, decoder, nullptr) < 0) {
        error = QStringLiteral("解码器打开失败（编码 %1）").arg(info.videoCodec);
        if (decCtx)
            avcodec_free_context(&decCtx);
        avformat_close_input(&inCtx);
        return false;
    }

    // --- Open output (MP4) + encoder. ---
    AVFormatContext* outCtx = nullptr;
    const QByteArray outPath = proxyPath.toUtf8();
    ret = avformat_alloc_output_context2(&outCtx, nullptr, "mp4", outPath.constData());
    if (ret < 0 || !outCtx) {
        error = QStringLiteral("无法创建代理文件：%1").arg(avErrorText(ret));
        avcodec_free_context(&decCtx);
        avformat_close_input(&inCtx);
        return false;
    }
    AVCodecContext* encCtx = avcodec_alloc_context3(encoder);
    if (!encCtx) {
        error = QStringLiteral("内存不足：无法分配代理编码器");
        avformat_free_context(outCtx);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inCtx);
        return false;
    }
    encCtx->width = dstW;
    encCtx->height = dstH;
    encCtx->pix_fmt = AV_PIX_FMT_YUV420P;
    encCtx->time_base = av_make_q(1, static_cast<int>(fps + 0.5));
    encCtx->framerate = av_make_q(static_cast<int>(fps + 0.5), 1);
    encCtx->bit_rate = 4000000;
    encCtx->gop_size = static_cast<int>(fps + 0.5);
    encCtx->max_b_frames = 0;

    AVDictionary* encOpts = nullptr;
    if (encoderName == QLatin1String("libvpx-vp9")) {
        av_dict_set(&encOpts, "deadline", "good", 0);
        av_dict_set(&encOpts, "cpu-used", "4", 0);
        av_dict_set(&encOpts, "crf", "32", 0);
        av_dict_set(&encOpts, "row-mt", "1", 0);
    }
    ret = avcodec_open2(encCtx, encoder, &encOpts);
    av_dict_free(&encOpts);
    if (ret < 0) {
        error = QStringLiteral("代理编码器 %1 打开失败：%2").arg(encoderName, avErrorText(ret));
        avcodec_free_context(&encCtx);
        avformat_free_context(outCtx);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inCtx);
        return false;
    }

    AVStream* outStream = avformat_new_stream(outCtx, nullptr);
    if (!outStream || avcodec_parameters_from_context(outStream->codecpar, encCtx) < 0) {
        error = QStringLiteral("无法创建代理输出流");
        avcodec_free_context(&encCtx);
        avformat_free_context(outCtx);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inCtx);
        return false;
    }
    outStream->time_base = encCtx->time_base;

    QDir().mkpath(QFileInfo(proxyPath).absolutePath());
    ret = avio_open(&outCtx->pb, outPath.constData(), AVIO_FLAG_WRITE);
    if (ret < 0) {
        error = QStringLiteral("无法写入代理文件 %1：%2").arg(proxyPath, avErrorText(ret));
        avcodec_free_context(&encCtx);
        avformat_free_context(outCtx);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inCtx);
        return false;
    }
    ret = avformat_write_header(outCtx, nullptr);
    if (ret < 0) {
        error = QStringLiteral("无法写入代理文件头：%1").arg(avErrorText(ret));
        avio_closep(&outCtx->pb);
        avcodec_free_context(&encCtx);
        avformat_free_context(outCtx);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inCtx);
        QFile::remove(proxyPath);
        return false;
    }

    // --- Transcode loop: decode -> scale -> encode. ---
    AVFrame* decFrame = av_frame_alloc();
    AVFrame* encFrame = av_frame_alloc();
    AVPacket* pkt = av_packet_alloc();
    SwsContext* swsCtx = nullptr;
    bool ok = false;
    int framesDone = 0;
    if (!decFrame || !encFrame || !pkt) {
        error = QStringLiteral("内存不足：无法分配代理转码缓冲");
    } else {
        encFrame->format = AV_PIX_FMT_YUV420P;
        encFrame->width = dstW;
        encFrame->height = dstH;
        if (av_frame_get_buffer(encFrame, 0) < 0) {
            error = QStringLiteral("内存不足：无法分配代理编码帧");
        } else {
            ok = true;
            bool inputEof = false;
            bool flushSent = false;
            while (ok) {
                ret = avcodec_receive_frame(decCtx, decFrame);
                if (ret == 0) {
                    if (!swsCtx) {
                        swsCtx = sws_getContext(decFrame->width, decFrame->height,
                                                static_cast<AVPixelFormat>(decFrame->format),
                                                dstW, dstH, AV_PIX_FMT_YUV420P, SWS_BILINEAR,
                                                nullptr, nullptr, nullptr);
                        if (!swsCtx) {
                            error = QStringLiteral("无法创建代理缩放器");
                            ok = false;
                            break;
                        }
                    }
                    if (av_frame_make_writable(encFrame) < 0) {
                        error = QStringLiteral("代理编码帧不可写");
                        ok = false;
                        break;
                    }
                    sws_scale(swsCtx, decFrame->data, decFrame->linesize, 0,
                              decFrame->height, encFrame->data, encFrame->linesize);
                    encFrame->pts = framesDone;
                    if (!drainEncoder(encCtx, outStream, outCtx, encFrame, pkt, error)) {
                        ok = false;
                        break;
                    }
                    ++framesDone;
                    if (progress) {
                        const double fraction = (totalFrames > 0)
                            ? static_cast<double>(framesDone) / totalFrames : 0.0;
                        progress(fraction, framesDone, totalFrames);
                    }
                    continue;
                }
                if (ret == AVERROR(EAGAIN)) {
                    if (inputEof) {
                        if (!flushSent) {
                            flushSent = true;
                            avcodec_send_packet(decCtx, nullptr);
                            continue;
                        }
                        break; // drained
                    }
                    ret = av_read_frame(inCtx, pkt);
                    if (ret < 0) {
                        inputEof = true;
                        continue;
                    }
                    if (pkt->stream_index != videoIndex) {
                        av_packet_unref(pkt);
                        continue;
                    }
                    ret = avcodec_send_packet(decCtx, pkt);
                    av_packet_unref(pkt);
                    if (ret < 0 && ret != AVERROR(EAGAIN)) {
                        error = QStringLiteral("代理解码送包失败：%1").arg(avErrorText(ret));
                        ok = false;
                        break;
                    }
                    continue;
                }
                if (ret == AVERROR_EOF)
                    break;
                error = QStringLiteral("代理解码失败：%1").arg(avErrorText(ret));
                ok = false;
                break;
            }
            if (ok && !drainEncoder(encCtx, outStream, outCtx, nullptr, pkt, error))
                ok = false;
        }
    }

    if (swsCtx)
        sws_freeContext(swsCtx);
    if (pkt)
        av_packet_free(&pkt);
    if (decFrame)
        av_frame_free(&decFrame);
    if (encFrame)
        av_frame_free(&encFrame);

    if (ok) {
        ret = av_write_trailer(outCtx);
        if (ret < 0) {
            error = QStringLiteral("无法完成代理文件：%1").arg(avErrorText(ret));
            ok = false;
        }
    }
    avio_closep(&outCtx->pb);
    avcodec_free_context(&encCtx);
    avformat_free_context(outCtx);
    avcodec_free_context(&decCtx);
    avformat_close_input(&inCtx);

    if (!ok) {
        QFile::remove(proxyPath); // never leave a partial proxy behind
        return false;
    }
    // A proxy that does not exist (or is empty) after a "successful" run
    // is a hard error, not a silent fallback to the original.
    const QFileInfo outInfo(proxyPath);
    if (!outInfo.exists() || outInfo.size() <= 0) {
        error = QStringLiteral("代理文件未生成：%1").arg(proxyPath);
        return false;
    }
    encoderUsed = encoderName;
    return true;
}

} // namespace catcut
