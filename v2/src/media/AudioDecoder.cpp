#include "media/AudioDecoder.h"

#include "media/MediaCommon.h"

#include <algorithm>
#include <cmath>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libavutil/rational.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}

namespace catcut {

double DecodedAudio::rms() const
{
    if (samples.isEmpty())
        return 0.0;
    double sum = 0.0;
    for (const float v : samples)
        sum += static_cast<double>(v) * v;
    return std::sqrt(sum / static_cast<double>(samples.size()));
}

namespace {

bool decodeRangeInternal(const QString& path, double sourceIn, double sourceOut,
                         DecodedAudio& out, QString& error)
{
    out = DecodedAudio();
    const QByteArray utf8Path = path.toUtf8();
    AVFormatContext* fmtCtx = nullptr;
    int ret = avformat_open_input(&fmtCtx, utf8Path.constData(), nullptr, nullptr);
    if (ret < 0) {
        error = QStringLiteral("音频解码：无法打开 %1（%2）。").arg(path, avErrorText(ret));
        return false;
    }
    ret = avformat_find_stream_info(fmtCtx, nullptr);
    if (ret < 0) {
        error = QStringLiteral("音频解码：无法读取 %1 的流信息（%2）。").arg(path, avErrorText(ret));
        avformat_close_input(&fmtCtx);
        return false;
    }
    const int streamIndex =
        av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (streamIndex < 0) {
        error = QStringLiteral("音频解码：%1 没有音频流。").arg(path);
        avformat_close_input(&fmtCtx);
        return false;
    }
    AVStream* stream = fmtCtx->streams[streamIndex];
    const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) {
        error = QStringLiteral("音频解码：%1 的音频编码不受支持。").arg(path);
        avformat_close_input(&fmtCtx);
        return false;
    }
    AVCodecContext* codecCtx = avcodec_alloc_context3(codec);
    if (!codecCtx) {
        error = QStringLiteral("音频解码：分配解码器失败。");
        avformat_close_input(&fmtCtx);
        return false;
    }
    ret = avcodec_parameters_to_context(codecCtx, stream->codecpar);
    if (ret < 0) {
        error = QStringLiteral("音频解码：复制编码参数失败（%1）。").arg(avErrorText(ret));
        avcodec_free_context(&codecCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }
    ret = avcodec_open2(codecCtx, codec, nullptr);
    if (ret < 0) {
        error = QStringLiteral("音频解码：打开解码器失败（%1）。").arg(avErrorText(ret));
        avcodec_free_context(&codecCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }

    // Resample to the mixer format: float, 48 kHz, stereo.
    SwrContext* swr = nullptr;
    ret = swr_alloc_set_opts2(&swr, &codecCtx->ch_layout, AV_SAMPLE_FMT_FLT, 48000,
                              &codecCtx->ch_layout, codecCtx->sample_fmt,
                              codecCtx->sample_rate, 0, nullptr);
    if (ret < 0 || !swr) {
        error = QStringLiteral("音频解码：创建重采样器失败（%1）。").arg(avErrorText(ret));
        avcodec_free_context(&codecCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }
    ret = swr_init(swr);
    if (ret < 0) {
        error = QStringLiteral("音频解码：初始化重采样器失败（%1）。").arg(avErrorText(ret));
        swr_free(&swr);
        avcodec_free_context(&codecCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }

    // Seek to the requested start (best-effort: a failed seek just
    // decodes from the beginning and trims by timestamp below).
    const bool haveRange = sourceOut > sourceIn;
    if (haveRange && sourceIn > 0.0) {
        const int64_t target = av_rescale_q(
            static_cast<int64_t>(sourceIn * 1000000.0), AV_TIME_BASE_Q, stream->time_base);
        if (av_seek_frame(fmtCtx, streamIndex, target, AVSEEK_FLAG_BACKWARD) >= 0)
            avcodec_flush_buffers(codecCtx);
    }

    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    if (!pkt || !frame) {
        error = QStringLiteral("音频解码：分配包/帧失败。");
        av_packet_free(&pkt);
        av_frame_free(&frame);
        swr_free(&swr);
        avcodec_free_context(&codecCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }

    // Running position in output samples, corrected by frame pts when
    // available. Frames are trimmed to [sourceIn, sourceOut).
    double runningTime = haveRange ? sourceIn : 0.0;
    bool anyFrame = false;
    bool ok = true;

    auto pushFrame = [&](AVFrame* f) {
        double frameStart = runningTime;
        if (f->pts != AV_NOPTS_VALUE) {
            const double ptsSeconds = static_cast<double>(f->pts)
                * av_q2d(stream->time_base);
            if (ptsSeconds >= 0.0 && ptsSeconds < runningTime + 2.0)
                frameStart = ptsSeconds;
        }
        const int outCount = static_cast<int>(
            swr_get_out_samples(swr, f->nb_samples));
        QVector<float> converted(static_cast<qsizetype>(outCount) * 2);
        uint8_t* outPtr = reinterpret_cast<uint8_t*>(converted.data());
        const int convertedCount = swr_convert(swr, &outPtr, outCount,
                                               const_cast<const uint8_t**>(f->data),
                                               f->nb_samples);
        if (convertedCount <= 0)
            return;
        // Trim to the requested range (sample-accurate).
        const double frameEnd = frameStart
            + static_cast<double>(convertedCount) / 48000.0;
        int skip = 0, take = convertedCount;
        if (haveRange) {
            if (frameEnd <= sourceIn || frameStart >= sourceOut) {
                runningTime = frameEnd;
                return;
            }
            if (frameStart < sourceIn)
                skip = static_cast<int>(std::llround((sourceIn - frameStart) * 48000.0));
            if (frameEnd > sourceOut)
                take = static_cast<int>(std::llround((sourceOut - frameStart) * 48000.0));
        }
        take = std::clamp(take, 0, convertedCount);
        skip = std::clamp(skip, 0, take);
        for (int i = skip; i < take; ++i) {
            out.samples.append(converted[static_cast<qsizetype>(i) * 2]);
            out.samples.append(converted[static_cast<qsizetype>(i) * 2 + 1]);
        }
        runningTime = frameEnd;
        anyFrame = true;
    };

    bool inputEof = false;
    while (true) {
        if (haveRange && runningTime >= sourceOut)
            break;
        if (!inputEof) {
            ret = av_read_frame(fmtCtx, pkt);
            if (ret < 0) {
                inputEof = true;
                ret = avcodec_send_packet(codecCtx, nullptr);
                if (ret < 0 && ret != AVERROR_EOF) {
                    error = QStringLiteral("音频解码：冲刷解码器失败（%1）。").arg(avErrorText(ret));
                    ok = false;
                    break;
                }
            } else if (pkt->stream_index != streamIndex) {
                av_packet_unref(pkt);
                continue;
            } else {
                ret = avcodec_send_packet(codecCtx, pkt);
                av_packet_unref(pkt);
                if (ret < 0) {
                    error = QStringLiteral("音频解码：送包失败（%1）。").arg(avErrorText(ret));
                    ok = false;
                    break;
                }
            }
        }
        while (true) {
            ret = avcodec_receive_frame(codecCtx, frame);
            if (ret == AVERROR(EAGAIN)) {
                break;
            }
            if (ret == AVERROR_EOF) {
                inputEof = true;
                break;
            }
            if (ret < 0) {
                error = QStringLiteral("音频解码：取帧失败（%1）。").arg(avErrorText(ret));
                ok = false;
                break;
            }
            pushFrame(frame);
            av_frame_unref(frame);
            if (haveRange && runningTime >= sourceOut)
                break;
        }
        if (!ok || (inputEof && ret == AVERROR_EOF))
            break;
        if (inputEof) {
            // Drain finished when receive returns EOF; loop again once
            // to let the inner drain run, then exit.
            ret = avcodec_receive_frame(codecCtx, frame);
            if (ret == AVERROR_EOF)
                break;
            if (ret >= 0) {
                pushFrame(frame);
                av_frame_unref(frame);
                continue;
            }
            break;
        }
    }

    av_packet_free(&pkt);
    av_frame_free(&frame);
    swr_free(&swr);
    avcodec_free_context(&codecCtx);
    avformat_close_input(&fmtCtx);

    if (!ok)
        return false;
    if (!anyFrame || out.samples.isEmpty()) {
        error = QStringLiteral("音频解码：%1 在请求范围内没有可解码的音频。").arg(path);
        return false;
    }
    out.sampleRate = 48000;
    out.channels = 2;
    return true;
}

} // namespace

bool AudioDecoder::decodeRange(const QString& path, double sourceIn, double sourceOut,
                               DecodedAudio& out, QString& error)
{
    if (sourceOut <= sourceIn) {
        error = QStringLiteral("音频解码：无效的范围 %1..%2。").arg(sourceIn).arg(sourceOut);
        return false;
    }
    return decodeRangeInternal(path, sourceIn, sourceOut, out, error);
}

bool AudioDecoder::decodeAll(const QString& path, DecodedAudio& out, QString& error)
{
    return decodeRangeInternal(path, 0.0, 0.0, out, error);
}

} // namespace catcut
