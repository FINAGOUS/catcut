// CatCut v2 — S1 media pipeline: import probing (ffprobe-style, no throws).

#include "media/MediaProbe.h"

#include "media/MediaCommon.h"

#include <QFileInfo>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/pixdesc.h>
#include <libavutil/rational.h>
}

namespace catcut {

namespace {

QString chromaFromPixDesc(const AVPixFmtDescriptor* desc)
{
    if (!desc)
        return QString();
    // log2_chroma_w/h describe the chroma subsampling.
    if (desc->log2_chroma_w == 0 && desc->log2_chroma_h == 0)
        return QStringLiteral("4:4:4");
    if (desc->log2_chroma_w == 1 && desc->log2_chroma_h == 0)
        return QStringLiteral("4:2:2");
    if (desc->log2_chroma_w == 1 && desc->log2_chroma_h == 1)
        return QStringLiteral("4:2:0");
    if (desc->log2_chroma_w == 2 && desc->log2_chroma_h == 0)
        return QStringLiteral("4:1:1");
    if (desc->log2_chroma_w == 2 && desc->log2_chroma_h == 1)
        return QStringLiteral("4:1:0");
    return QString();
}

double rationalToDouble(AVRational r)
{
    if (r.num <= 0 || r.den <= 0)
        return 0.0;
    return av_q2d(r);
}

} // namespace

MediaInfo MediaProbe::probe(const QString& path)
{
    MediaInfo info;

    if (!QFileInfo::exists(path)) {
        info.error = QStringLiteral("文件不存在：%1").arg(path);
        return info;
    }

    AVFormatContext* fmtCtx = nullptr;
    const QByteArray utf8Path = path.toUtf8();
    int ret = avformat_open_input(&fmtCtx, utf8Path.constData(), nullptr, nullptr);
    if (ret < 0 || !fmtCtx) {
        info.error = QStringLiteral("打不开文件（容器无法识别或文件头已损坏）：%1").arg(avErrorText(ret));
        return info;
    }

    // find_stream_info failing must not be fatal: headers alone may still
    // describe the streams. Record it as a warning instead.
    ret = avformat_find_stream_info(fmtCtx, nullptr);
    if (ret < 0)
        info.warning = QStringLiteral("无法读取完整流信息（%1），以下数据可能不完整").arg(avErrorText(ret));

    if (fmtCtx->iformat) {
        info.container = QString::fromUtf8(fmtCtx->iformat->name);
        info.containerLongName = QString::fromUtf8(fmtCtx->iformat->long_name);
    }

    if (fmtCtx->duration != AV_NOPTS_VALUE && fmtCtx->duration > 0)
        info.durationSeconds = static_cast<double>(fmtCtx->duration) / AV_TIME_BASE;

    const int videoIndex = av_find_best_stream(fmtCtx, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (videoIndex >= 0) {
        AVStream* stream = fmtCtx->streams[videoIndex];
        const AVCodecParameters* par = stream->codecpar;
        info.hasVideo = true;
        info.width = par->width;
        info.height = par->height;
        const char* codecName = avcodec_get_name(static_cast<AVCodecID>(par->codec_id));
        if (codecName)
            info.videoCodec = QString::fromLatin1(codecName);
        const AVCodecDescriptor* codecDesc = avcodec_descriptor_get(static_cast<AVCodecID>(par->codec_id));
        if (codecDesc && codecDesc->long_name)
            info.videoCodecLongName = QString::fromUtf8(codecDesc->long_name);
        if (par->format != AV_PIX_FMT_NONE) {
            const char* pixName = av_get_pix_fmt_name(static_cast<AVPixelFormat>(par->format));
            if (pixName)
                info.pixFmt = QString::fromLatin1(pixName);
            const AVPixFmtDescriptor* desc = av_pix_fmt_desc_get(static_cast<AVPixelFormat>(par->format));
            if (desc) {
                info.chroma = chromaFromPixDesc(desc);
                if (desc->comp[0].depth > 0)
                    info.bitDepth = desc->comp[0].depth;
            }
        }
        if (par->bits_per_raw_sample > 0)
            info.bitDepth = par->bits_per_raw_sample;
        info.fps = rationalToDouble(av_guess_frame_rate(fmtCtx, stream, nullptr));
        if (info.fps <= 0.0)
            info.fps = rationalToDouble(stream->avg_frame_rate);
        if (info.fps <= 0.0)
            info.fps = rationalToDouble(stream->r_frame_rate);
        if (info.durationSeconds <= 0.0 && stream->duration != AV_NOPTS_VALUE && stream->duration > 0)
            info.durationSeconds = static_cast<double>(stream->duration) * av_q2d(stream->time_base);
        if (info.fps <= 0.0) {
            if (!info.warning.isEmpty())
                info.warning += QStringLiteral("；");
            info.warning += QStringLiteral("帧率未知");
        }
    }

    const int audioIndex = av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (audioIndex >= 0) {
        const AVCodecParameters* par = fmtCtx->streams[audioIndex]->codecpar;
        info.hasAudio = true;
        const char* codecName = avcodec_get_name(static_cast<AVCodecID>(par->codec_id));
        if (codecName)
            info.audioCodec = QString::fromLatin1(codecName);
        info.audioChannels = par->ch_layout.nb_channels;
        info.audioSampleRate = par->sample_rate;
    }

    if (!info.hasVideo && !info.hasAudio) {
        info.error = QStringLiteral("文件中没有可识别的音视频流（文件可能已损坏、为空，或是裸流/未受支持的容器）");
        avformat_close_input(&fmtCtx);
        return info;
    }

    if (!info.hasVideo && info.hasAudio) {
        if (!info.warning.isEmpty())
            info.warning += QStringLiteral("；");
        info.warning += QStringLiteral("纯音频文件，无视频轨");
    }

    if (info.durationSeconds <= 0.0) {
        if (!info.warning.isEmpty())
            info.warning += QStringLiteral("；");
        info.warning += QStringLiteral("时长未知");
    }

    info.ok = true;
    avformat_close_input(&fmtCtx);
    return info;
}

QString MediaProbe::describe(const MediaInfo& info)
{
    if (!info.ok)
        return info.error;
    QString out;
    if (info.hasVideo) {
        out += QStringLiteral("%1x%2").arg(info.width).arg(info.height);
        if (!info.videoCodec.isEmpty())
            out += QStringLiteral(" %1").arg(info.videoCodec);
        if (info.bitDepth > 0)
            out += QStringLiteral(" %1bit").arg(info.bitDepth);
        if (!info.chroma.isEmpty())
            out += QStringLiteral(" %1").arg(info.chroma);
        if (info.fps > 0.0)
            out += QStringLiteral(" %1fps").arg(info.fps, 0, 'g', 4);
    }
    if (info.hasAudio) {
        if (!out.isEmpty())
            out += QStringLiteral(" + ");
        out += info.audioCodec.isEmpty() ? QStringLiteral("音频") : info.audioCodec;
    }
    if (info.durationSeconds > 0.0)
        out += QStringLiteral(" · %1s").arg(info.durationSeconds, 0, 'f', 1);
    if (!info.warning.isEmpty())
        out += QStringLiteral("（%1）").arg(info.warning);
    return out;
}

} // namespace catcut
