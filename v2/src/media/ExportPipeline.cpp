#include "media/ExportPipeline.h"

#include "core/Subtitles.h"
#include "core/TimelineEvaluator.h"
#include "core/TimelineModel.h"
#include "media/ExportFrameRenderer.h"
#include "media/Loudness.h"
#include "media/MediaCommon.h"

#include <QDir>
#include <QDebug>
#include <QFile>
#include <QImage>
#include <QtMath>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libavutil/rational.h>
#include <libavutil/samplefmt.h>
#include <libswscale/swscale.h>
}

namespace catcut {

namespace {

constexpr int kMixSampleRate = 48000;

// RAII wrappers so every early return frees the FFmpeg objects.
struct PacketGuard {
    AVPacket* pkt = av_packet_alloc();
    ~PacketGuard() { av_packet_free(&pkt); }
};

struct FrameGuard {
    AVFrame* frame = av_frame_alloc();
    ~FrameGuard() { av_frame_free(&frame); }
};

QString sanitiseRoleForFilename(const QString& role)
{
    QString out;
    for (const QChar c : role) {
        if (c.isLetterOrNumber() || c == QLatin1Char('_') || c == QLatin1Char('-'))
            out.append(c);
        else
            out.append(QLatin1Char('_'));
    }
    if (out.isEmpty())
        out = QStringLiteral("role");
    return out;
}

} // namespace

QStringList ExportPipeline::encoderCandidates(VideoCodec codec)
{
    if (codec == VideoCodec::H265) {
        return {QStringLiteral("hevc_nvenc"), QStringLiteral("hevc_qsv"),
                QStringLiteral("hevc_amf"), QStringLiteral("hevc_mf")};
    }
    return {QStringLiteral("h264_nvenc"), QStringLiteral("h264_qsv"),
            QStringLiteral("h264_amf"), QStringLiteral("libopenh264"),
            QStringLiteral("h264_mf")};
}

bool ExportPipeline::isHardwareEncoder(const QString& encoderName)
{
    return encoderName.contains(QStringLiteral("_nvenc"))
        || encoderName.contains(QStringLiteral("_qsv"))
        || encoderName.contains(QStringLiteral("_amf"));
}

// ---------------------------------------------------------------- audio mix

DecodedAudio ExportPipeline::mixTimelineAudio(const TimelineModel* model,
                                              const RoleMixTable& mix,
                                              const QString& onlyRole)
{
    DecodedAudio mixed;
    if (!model)
        return mixed;
    const double duration = model->totalDuration();
    if (duration <= 0.0)
        return mixed;
    const int totalFrames = static_cast<int>(std::ceil(duration * kMixSampleRate));
    mixed.sampleRate = kMixSampleRate;
    mixed.channels = 2;
    mixed.samples.fill(0.0f, static_cast<qsizetype>(totalFrames) * 2);

    QList<const Clip*> clips;
    for (const Clip& c : model->primaryClips())
        clips.append(&c);
    for (const Clip& c : model->connectedClips())
        clips.append(&c);

    for (const Clip* clip : clips) {
        if (clip->kind == ClipKind::Title || !clip->enabled || clip->mediaPath.isEmpty())
            continue;
        if (!onlyRole.isEmpty() && clip->role != onlyRole)
            continue;
        DecodedAudio decoded;
        QString decodeError;
        if (!AudioDecoder::decodeRange(clip->mediaPath, clip->sourceIn, clip->sourceOut,
                                       decoded, decodeError)) {
            // A clip whose audio cannot be decoded is skipped with a
            // note in the log, never a crash: the video export must
            // not die because one clip lost its audio. (The video
            // side is stricter — see exportTimeline.)
            qWarning("ExportPipeline: skipping audio of clip %s: %s",
                     qUtf8Printable(clip->id), qUtf8Printable(decodeError));
            continue;
        }
        const std::pair<double, double> pan = mix.panGains(clip->role);
        const double startFrame = clip->timelineStart * kMixSampleRate;
        const int startIndex = static_cast<int>(std::llround(startFrame));
        const int frames = decoded.frameCount();
        for (int i = 0; i < frames; ++i) {
            const int outIndex = startIndex + i;
            if (outIndex < 0 || outIndex >= totalFrames)
                continue;
            const double localTime = static_cast<double>(i) / kMixSampleRate;
            const double gain = clip->volume
                * clip->keyframes.volumeAt(
                      std::clamp(localTime, 0.0, clip->duration()))
                * fadeGain(localTime, clip->duration(),
                           clip->fadeInSeconds, clip->fadeOutSeconds);
            const float left = decoded.samples[static_cast<qsizetype>(i) * 2];
            const float right = decoded.samples[static_cast<qsizetype>(i) * 2 + 1];
            float& outLeft = mixed.samples[static_cast<qsizetype>(outIndex) * 2];
            float& outRight = mixed.samples[static_cast<qsizetype>(outIndex) * 2 + 1];
            outLeft = static_cast<float>(outLeft + left * gain * pan.first);
            outRight = static_cast<float>(outRight + right * gain * pan.second);
        }
    }
    // Trim trailing silence: keep the full timeline length when any
    // sample is non-silent, otherwise report empty (no audible clips).
    bool anySound = false;
    for (const float v : mixed.samples) {
        if (std::fabs(v) > 1e-6f) {
            anySound = true;
            break;
        }
    }
    if (!anySound)
        return DecodedAudio();
    return mixed;
}

bool ExportPipeline::writeWav(const QString& path, const DecodedAudio& audio, QString& error)
{
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        error = QStringLiteral("写 WAV 失败：无法创建 %1。").arg(path);
        return false;
    }
    const quint32 sampleRate = static_cast<quint32>(audio.sampleRate);
    const quint16 channels = static_cast<quint16>(audio.channels);
    const quint32 dataBytes = static_cast<quint32>(audio.samples.size()) * 2u;
    auto writeU32 = [&file](quint32 v) {
        const char b[4] = {char(v & 0xFF), char((v >> 8) & 0xFF),
                           char((v >> 16) & 0xFF), char((v >> 24) & 0xFF)};
        file.write(b, 4);
    };
    auto writeU16 = [&file](quint16 v) {
        const char b[2] = {char(v & 0xFF), char((v >> 8) & 0xFF)};
        file.write(b, 2);
    };
    file.write("RIFF", 4);
    writeU32(36 + dataBytes);
    file.write("WAVE", 4);
    file.write("fmt ", 4);
    writeU32(16);
    writeU16(1); // PCM
    writeU16(channels);
    writeU32(sampleRate);
    writeU32(sampleRate * channels * 2);
    writeU16(channels * 2);
    writeU16(16);
    file.write("data", 4);
    writeU32(dataBytes);
    for (const float v : audio.samples) {
        const qint16 s = static_cast<qint16>(
            std::clamp(static_cast<double>(v), -1.0, 1.0) * 32767.0);
        writeU16(static_cast<quint16>(s));
    }
    file.close();
    if (file.error() != QFile::NoError) {
        error = QStringLiteral("写 WAV 失败：写入 %1 时出错。").arg(path);
        return false;
    }
    return true;
}

StemResult ExportPipeline::exportStems(const TimelineModel* model,
                                       const QString& outputDir,
                                       const QString& baseName,
                                       const RoleMixTable& mix)
{
    StemResult result;
    if (!model) {
        result.error = QStringLiteral("分轨导出：时间线为空。");
        return result;
    }
    const QDir dir(outputDir);
    if (!dir.exists()) {
        result.error = QStringLiteral("分轨导出：输出目录不存在：%1").arg(outputDir);
        return result;
    }
    const QMap<QString, QList<QString>> stems = model->stemsByRole();
    if (stems.isEmpty()) {
        result.error = QStringLiteral("分轨导出：时间线里没有任何角色。");
        return result;
    }
    for (auto it = stems.begin(); it != stems.end(); ++it) {
        const QString role = it.key();
        DecodedAudio mixed = mixTimelineAudio(model, mix, role);
        if (mixed.samples.isEmpty())
            continue; // role has no audible clips (e.g. titles only)
        const QString path = dir.filePath(baseName + QStringLiteral("_")
                                          + sanitiseRoleForFilename(role)
                                          + QStringLiteral(".wav"));
        QString error;
        if (!writeWav(path, mixed, error)) {
            result.error = error;
            return result;
        }
        result.files.insert(role, path);
        result.durations.insert(role, mixed.durationSeconds());
    }
    if (result.files.isEmpty()) {
        result.error = QStringLiteral("分轨导出：没有任何角色有可导出的音频。");
        return result;
    }
    result.ok = true;
    return result;
}

// ------------------------------------------------------------------ export

ExportResult ExportPipeline::exportTimeline(const TimelineModel* model,
                                            const ExportPreset& preset,
                                            const QString& outputPath,
                                            const ExportOptions& options)
{
    ExportResult result;
    result.outputPath = outputPath;
    result.loudnessLUFS = std::numeric_limits<double>::quiet_NaN();

    auto fail = [&](const QString& message) {
        result.error = message;
        QFile::remove(outputPath);
        return result;
    };

    if (!model || model->isEmpty()) {
        return fail(QStringLiteral("导出：时间线为空，没有可导出的内容。"));
    }
    QString presetError;
    if (!preset.isValid(presetError)) {
        return fail(QStringLiteral("导出：%1").arg(presetError));
    }
    const double duration = model->totalDuration();
    if (duration <= 0.0) {
        return fail(QStringLiteral("导出：时间线总时长为 0。"));
    }
    if (options.cancel && options.cancel->load()) {
        result.cancelled = true;
        return fail(QStringLiteral("导出已取消。"));
    }
    result.durationSeconds = duration;
    result.bitrateBps = preset.bitrateBps();

    const int width = preset.width;
    const int height = preset.height;
    const double fps = preset.fps;
    const int totalFrames = static_cast<int>(std::ceil(duration * fps));

    // --- mix the audio first (cheap, in memory) ---
    DecodedAudio mixedAudio = mixTimelineAudio(model, options.mix);
    result.hasAudio = !mixedAudio.samples.isEmpty();
    if (result.hasAudio && options.loudnessNormalize) {
        double measuredBefore = 0.0, appliedGain = 0.0;
        QString loudnessError;
        QVector<float> normalised = Loudness::normalizeToTarget(
            mixedAudio.samples, measuredBefore, appliedGain, loudnessError);
        if (!normalised.isEmpty()) {
            mixedAudio.samples = normalised;
            result.loudnessLUFS = kLoudnessTargetLUFS;
            result.fallbackNote = QStringLiteral("响度：实测 %1 LUFS，已用 %2 dB 线性增益统一到 -16 LUFS。")
                                      .arg(measuredBefore, 0, 'f', 2).arg(appliedGain, 0, 'f', 2);
        } else {
            // Measurement failed: export with the un-normalised mix
            // and say so, instead of failing the whole export.
            result.fallbackNote = QStringLiteral("响度：测量失败（%1），未做响度统一。")
                                      .arg(loudnessError);
            QString measureError;
            const double measured = Loudness::measureIntegrated(mixedAudio.samples, measureError);
            result.loudnessLUFS = measured;
        }
    } else if (result.hasAudio) {
        QString measureError;
        result.loudnessLUFS = Loudness::measureIntegrated(mixedAudio.samples, measureError);
    }

    // --- open the video encoder (hardware first, software fallback) ---
    const QStringList candidates = encoderCandidates(preset.codec);
    const AVCodec* videoCodec = nullptr;
    AVCodecContext* videoCtx = nullptr;
    QString encoderName;
    QStringList openFailures;
    for (const QString& candidate : candidates) {
        const AVCodec* codec = avcodec_find_encoder_by_name(candidate.toUtf8().constData());
        if (!codec) {
            openFailures.append(candidate + QStringLiteral("（本机 FFmpeg 没有这个编码器）"));
            continue;
        }
        AVCodecContext* ctx = avcodec_alloc_context3(codec);
        if (!ctx) {
            openFailures.append(candidate + QStringLiteral("（分配失败）"));
            continue;
        }
        ctx->width = width;
        ctx->height = height;
        ctx->pix_fmt = AV_PIX_FMT_YUV420P;
        ctx->time_base = AVRational{1, static_cast<int>(std::llround(fps))};
        ctx->framerate = AVRational{static_cast<int>(std::llround(fps)), 1};
        ctx->gop_size = static_cast<int>(std::llround(fps)) * 2;
        ctx->bit_rate = preset.bitrateBps();
        if (candidate == QStringLiteral("libopenh264"))
            ctx->max_b_frames = 0; // openh264 does not support B-frames
        // Encoder speed presets (best-effort: unknown options are ignored).
        if (candidate.contains(QStringLiteral("nvenc")))
            av_opt_set(ctx->priv_data, "preset", "p4", 0);
        else if (candidate.contains(QStringLiteral("qsv")))
            av_opt_set(ctx->priv_data, "preset", "veryfast", 0);
        else if (candidate.contains(QStringLiteral("amf")))
            av_opt_set(ctx->priv_data, "quality", "balanced", 0);
        const int openRet = avcodec_open2(ctx, codec, nullptr);
        if (openRet < 0) {
            openFailures.append(candidate + QStringLiteral("（打开失败：%1）").arg(avErrorText(openRet)));
            avcodec_free_context(&ctx);
            continue;
        }
        videoCodec = codec;
        videoCtx = ctx;
        encoderName = candidate;
        break;
    }
    if (!videoCtx) {
        const QString hint = preset.codec == VideoCodec::H265
            ? QStringLiteral("H.265 在本机没有可用的编码器：LGPL 发行版不含 libx265（GPL），"
                             "需要一块支持 HEVC 硬件编码的显卡（NVENC/QSV/AMF）。请改用 H.264 预设。")
            : QStringLiteral("H.264 在本机没有可用的编码器。");
        return fail(QStringLiteral("导出：%1\n尝试过的编码器：%2")
                        .arg(hint, openFailures.join(QStringLiteral("；"))));
    }
    result.encoderName = encoderName;
    result.hardwareEncoder = isHardwareEncoder(encoderName);
    if (encoderName != candidates.first()) {
        const QString note = QStringLiteral("编码器：首选 %1 不可用（%2），已回退到 %3。")
                                 .arg(candidates.first(), openFailures.join(QStringLiteral("；")), encoderName);
        result.fallbackNote = result.fallbackNote.isEmpty()
            ? note : result.fallbackNote + QStringLiteral("\n") + note;
    }

    // --- open the audio encoder (AAC) ---
    AVCodecContext* audioCtx = nullptr;
    const AVCodec* audioCodec = nullptr;
    if (result.hasAudio) {
        audioCodec = avcodec_find_encoder_by_name("aac");
        if (audioCodec) {
            audioCtx = avcodec_alloc_context3(audioCodec);
            if (audioCtx) {
                audioCtx->sample_fmt = AV_SAMPLE_FMT_FLTP;
                audioCtx->sample_rate = kMixSampleRate;
                audioCtx->ch_layout = AV_CHANNEL_LAYOUT_STEREO;
                audioCtx->time_base = AVRational{1, kMixSampleRate};
                audioCtx->bit_rate = preset.audioBitrateBps;
                if (avcodec_open2(audioCtx, audioCodec, nullptr) < 0) {
                    avcodec_free_context(&audioCtx);
                    audioCtx = nullptr;
                }
            }
        }
        if (!audioCtx) {
            // AAC unavailable: keep the video, drop the audio track
            // and say so — a silent export beats no export.
            result.hasAudio = false;
            result.fallbackNote += QStringLiteral("\n音频：AAC 编码器不可用，本次导出无音轨。");
        }
    }

    // --- muxer ---
    AVFormatContext* fmtCtx = nullptr;
    const QByteArray outputUtf8 = outputPath.toUtf8();
    int ret = avformat_alloc_output_context2(
        &fmtCtx, nullptr, exportContainerName(preset.container).toLatin1().constData(),
        outputUtf8.constData());
    if (ret < 0 || !fmtCtx) {
        avcodec_free_context(&videoCtx);
        if (audioCtx)
            avcodec_free_context(&audioCtx);
        return fail(QStringLiteral("导出：创建输出容器失败（%1）。").arg(avErrorText(ret)));
    }
    AVStream* videoStream = avformat_new_stream(fmtCtx, nullptr);
    if (!videoStream) {
        avformat_free_context(fmtCtx);
        avcodec_free_context(&videoCtx);
        if (audioCtx)
            avcodec_free_context(&audioCtx);
        return fail(QStringLiteral("导出：创建视频流失败。"));
    }
    videoStream->time_base = videoCtx->time_base;
    ret = avcodec_parameters_from_context(videoStream->codecpar, videoCtx);
    if (ret < 0) {
        avformat_free_context(fmtCtx);
        avcodec_free_context(&videoCtx);
        if (audioCtx)
            avcodec_free_context(&audioCtx);
        return fail(QStringLiteral("导出：复制视频编码参数失败（%1）。").arg(avErrorText(ret)));
    }
    AVStream* audioStream = nullptr;
    if (audioCtx) {
        audioStream = avformat_new_stream(fmtCtx, nullptr);
        if (!audioStream) {
            avformat_free_context(fmtCtx);
            avcodec_free_context(&videoCtx);
            avcodec_free_context(&audioCtx);
            return fail(QStringLiteral("导出：创建音频流失败。"));
        }
        audioStream->time_base = audioCtx->time_base;
        ret = avcodec_parameters_from_context(audioStream->codecpar, audioCtx);
        if (ret < 0) {
            avformat_free_context(fmtCtx);
            avcodec_free_context(&videoCtx);
            avcodec_free_context(&audioCtx);
            return fail(QStringLiteral("导出：复制音频编码参数失败（%1）。").arg(avErrorText(ret)));
        }
    }
    if (!(fmtCtx->oformat->flags & AVFMT_NOFILE)) {
        ret = avio_open(&fmtCtx->pb, outputUtf8.constData(), AVIO_FLAG_WRITE);
        if (ret < 0) {
            avformat_free_context(fmtCtx);
            avcodec_free_context(&videoCtx);
            if (audioCtx)
                avcodec_free_context(&audioCtx);
            return fail(QStringLiteral("导出：无法创建输出文件 %1（%2）。")
                            .arg(outputPath, avErrorText(ret)));
        }
    }
    ret = avformat_write_header(fmtCtx, nullptr);
    if (ret < 0) {
        if (!(fmtCtx->oformat->flags & AVFMT_NOFILE))
            avio_closep(&fmtCtx->pb);
        avformat_free_context(fmtCtx);
        avcodec_free_context(&videoCtx);
        if (audioCtx)
            avcodec_free_context(&audioCtx);
        return fail(QStringLiteral("导出：写文件头失败（%1）。").arg(avErrorText(ret)));
    }

    // --- frame loop: shared render path -> YUV420P -> encoder ---
    SwsContext* swsCtx = sws_getContext(width, height, AV_PIX_FMT_RGBA,
                                        width, height, AV_PIX_FMT_YUV420P,
                                        SWS_BILINEAR, nullptr, nullptr, nullptr);
    if (!swsCtx) {
        av_write_trailer(fmtCtx);
        if (!(fmtCtx->oformat->flags & AVFMT_NOFILE))
            avio_closep(&fmtCtx->pb);
        avformat_free_context(fmtCtx);
        avcodec_free_context(&videoCtx);
        if (audioCtx)
            avcodec_free_context(&audioCtx);
        return fail(QStringLiteral("导出：创建色彩转换器失败。"));
    }

    bool ok = true;
    QString loopError;
    int audioFrameSize = audioCtx ? audioCtx->frame_size : 1024;
    if (audioFrameSize <= 0)
        audioFrameSize = 1024;
    int audioFedFrames = 0; // 48k sample frames already fed to the AAC encoder

    auto writeVideoPacket = [&](AVPacket* pkt) {
        av_packet_rescale_ts(pkt, videoCtx->time_base, videoStream->time_base);
        pkt->stream_index = videoStream->index;
        return av_interleaved_write_frame(fmtCtx, pkt);
    };
    auto writeAudioPacket = [&](AVPacket* pkt) {
        av_packet_rescale_ts(pkt, audioCtx->time_base, audioStream->time_base);
        pkt->stream_index = audioStream->index;
        return av_interleaved_write_frame(fmtCtx, pkt);
    };
    // Feeds one AAC frame (audioFrameSize samples starting at
    // `startSample`, zero-padded at the end of the mix).
    auto feedAudioFrame = [&](int startSample) -> bool {
        FrameGuard frameGuard;
        AVFrame* frame = frameGuard.frame;
        frame->format = AV_SAMPLE_FMT_FLTP;
        frame->ch_layout = AV_CHANNEL_LAYOUT_STEREO;
        frame->sample_rate = kMixSampleRate;
        frame->nb_samples = audioFrameSize;
        frame->pts = startSample;
        if (av_frame_get_buffer(frame, 0) < 0)
            return false;
        float* left = reinterpret_cast<float*>(frame->data[0]);
        float* right = reinterpret_cast<float*>(frame->data[1]);
        for (int i = 0; i < audioFrameSize; ++i) {
            const int idx = startSample + i;
            if (idx < mixedAudio.frameCount()) {
                left[i] = mixedAudio.samples[static_cast<qsizetype>(idx) * 2];
                right[i] = mixedAudio.samples[static_cast<qsizetype>(idx) * 2 + 1];
            } else {
                left[i] = 0.0f;
                right[i] = 0.0f;
            }
        }
        if (avcodec_send_frame(audioCtx, frame) < 0)
            return false;
        PacketGuard pktGuard;
        while (true) {
            const int recv = avcodec_receive_packet(audioCtx, pktGuard.pkt);
            if (recv == AVERROR(EAGAIN) || recv == AVERROR_EOF)
                break;
            if (recv < 0)
                return false;
            if (writeAudioPacket(pktGuard.pkt) < 0)
                return false;
            av_packet_unref(pktGuard.pkt);
        }
        return true;
    };

    for (int i = 0; i < totalFrames && ok; ++i) {
        if (options.cancel && options.cancel->load()) {
            ok = false;
            result.cancelled = true;
            loopError = QStringLiteral("导出已取消。");
            break;
        }
        const double t = static_cast<double>(i) / fps;
        QImage rendered;
        QString renderError;
        if (!ExportFrameRenderer::renderExportFrame(model, t, QSize(width, height),
                                                    rendered, renderError)) {
            ok = false;
            loopError = QStringLiteral("导出：第 %1 帧渲染失败：%2").arg(i).arg(renderError);
            break;
        }
        const QImage rgba = rendered.format() == QImage::Format_RGBA8888
            ? rendered : rendered.convertToFormat(QImage::Format_RGBA8888);
        FrameGuard frameGuard;
        AVFrame* frame = frameGuard.frame;
        frame->format = AV_PIX_FMT_YUV420P;
        frame->width = width;
        frame->height = height;
        frame->pts = i;
        if (av_frame_get_buffer(frame, 0) < 0) {
            ok = false;
            loopError = QStringLiteral("导出：第 %1 帧分配失败。").arg(i);
            break;
        }
        if (av_frame_make_writable(frame) < 0) {
            ok = false;
            loopError = QStringLiteral("导出：第 %1 帧不可写。").arg(i);
            break;
        }
        const uint8_t* srcSlice[1] = {rgba.constBits()};
        const int srcStride[1] = {static_cast<int>(rgba.bytesPerLine())};
        sws_scale(swsCtx, srcSlice, srcStride, 0, height, frame->data, frame->linesize);
        if (avcodec_send_frame(videoCtx, frame) < 0) {
            ok = false;
            loopError = QStringLiteral("导出：第 %1 帧送编码器失败。").arg(i);
            break;
        }
        PacketGuard pktGuard;
        while (true) {
            const int recv = avcodec_receive_packet(videoCtx, pktGuard.pkt);
            if (recv == AVERROR(EAGAIN) || recv == AVERROR_EOF)
                break;
            if (recv < 0) {
                ok = false;
                loopError = QStringLiteral("导出：第 %1 帧编码失败（%2）。").arg(i).arg(avErrorText(recv));
                break;
            }
            if (writeVideoPacket(pktGuard.pkt) < 0) {
                ok = false;
                loopError = QStringLiteral("导出：第 %1 帧写文件失败。").arg(i);
                break;
            }
            av_packet_unref(pktGuard.pkt);
        }
        if (!ok)
            break;
        // Keep the audio interleaved with the video: feed AAC frames
        // up to the end of this video frame.
        if (audioCtx) {
            const int targetSamples = static_cast<int>(
                std::llround(static_cast<double>(i + 1) / fps * kMixSampleRate));
            while (audioFedFrames + audioFrameSize <= targetSamples) {
                if (!feedAudioFrame(audioFedFrames)) {
                    ok = false;
                    loopError = QStringLiteral("导出：音频编码失败（第 %1 帧附近）。").arg(i);
                    break;
                }
                audioFedFrames += audioFrameSize;
            }
            if (!ok)
                break;
        }
        if (options.progress)
            options.progress(i + 1, totalFrames);
    }

    // Flush the video encoder, then the remaining audio.
    if (ok) {
        avcodec_send_frame(videoCtx, nullptr);
        PacketGuard pktGuard;
        while (true) {
            const int recv = avcodec_receive_packet(videoCtx, pktGuard.pkt);
            if (recv == AVERROR(EAGAIN) || recv == AVERROR_EOF)
                break;
            if (recv < 0) {
                ok = false;
                loopError = QStringLiteral("导出：冲刷视频编码器失败（%1）。").arg(avErrorText(recv));
                break;
            }
            if (writeVideoPacket(pktGuard.pkt) < 0) {
                ok = false;
                loopError = QStringLiteral("导出：冲刷视频写文件失败。");
                break;
            }
            av_packet_unref(pktGuard.pkt);
        }
    }
    if (ok && audioCtx) {
        while (audioFedFrames < mixedAudio.frameCount()) {
            if (!feedAudioFrame(audioFedFrames)) {
                ok = false;
                loopError = QStringLiteral("导出：音频编码失败（尾部）。");
                break;
            }
            audioFedFrames += audioFrameSize;
        }
        if (ok) {
            avcodec_send_frame(audioCtx, nullptr);
            PacketGuard pktGuard;
            while (true) {
                const int recv = avcodec_receive_packet(audioCtx, pktGuard.pkt);
                if (recv == AVERROR(EAGAIN) || recv == AVERROR_EOF)
                    break;
                if (recv < 0)
                    break; // trailing flush failure: trailer still written
                if (writeAudioPacket(pktGuard.pkt) < 0)
                    break;
                av_packet_unref(pktGuard.pkt);
            }
        }
    }

    sws_freeContext(swsCtx);
    if (ok)
        av_write_trailer(fmtCtx);
    if (!(fmtCtx->oformat->flags & AVFMT_NOFILE))
        avio_closep(&fmtCtx->pb);
    avformat_free_context(fmtCtx);
    avcodec_free_context(&videoCtx);
    if (audioCtx)
        avcodec_free_context(&audioCtx);

    if (!ok) {
        result.error = loopError;
        QFile::remove(outputPath);
        return result;
    }

    // SRT sidecar next to the export (same base name).
    if (options.writeSrtSidecar && !model->subtitles().isEmpty()) {
        const QString srtPath = outputPath + QStringLiteral(".srt");
        QFile srtFile(srtPath);
        if (srtFile.open(QIODevice::WriteOnly | QIODevice::Text)) {
            srtFile.write(model->subtitles().toSrt().toUtf8());
            srtFile.close();
        }
    }

    result.ok = true;
    return result;
}

} // namespace catcut
