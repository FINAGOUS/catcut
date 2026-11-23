#include "media/AudioDenoise.h"

#include "media/MediaCommon.h"

#include <algorithm>
#include <cmath>
#include <cstring>

extern "C" {
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
}

namespace catcut {

bool AudioDenoise::isAvailable()
{
    return avfilter_get_by_name("afftdn") != nullptr;
}

QVector<float> AudioDenoise::applyAfftdn(const QVector<float>& samples, QString& error)
{
    if (samples.isEmpty() || (samples.size() % 2) != 0) {
        error = QStringLiteral("降噪：输入为空或不是立体声交错采样。");
        return {};
    }
    const AVFilter* abuffer = avfilter_get_by_name("abuffer");
    const AVFilter* afftdn = avfilter_get_by_name("afftdn");
    // NOTE: the sink MUST be abuffersink (same lesson as Loudness:
    // anullsink does not implement the buffersink pull API).
    const AVFilter* sink = avfilter_get_by_name("abuffersink");
    if (!abuffer || !afftdn || !sink) {
        error = QStringLiteral("降噪：FFmpeg 缺少 abuffer/afftdn/abuffersink 滤镜。");
        return {};
    }

    AVFilterGraph* graph = avfilter_graph_alloc();
    if (!graph) {
        error = QStringLiteral("降噪：分配滤镜图失败。");
        return {};
    }

    AVFilterContext* srcCtx = nullptr;
    AVFilterContext* dnCtx = nullptr;
    AVFilterContext* sinkCtx = nullptr;
    auto failGraph = [&](const QString& message) {
        error = message;
        avfilter_graph_free(&graph);
        return QVector<float>();
    };

    int ret = avfilter_graph_create_filter(
        &srcCtx, abuffer, "in",
        "sample_rate=48000:sample_fmt=flt:channel_layout=stereo:time_base=1/48000",
        nullptr, graph);
    if (ret < 0)
        return failGraph(QStringLiteral("降噪：创建 abuffer 失败（%1）。").arg(avErrorText(ret)));
    // nr=12 is the FFmpeg default; spelled out so the behaviour is
    // pinned, not whatever a future default becomes.
    ret = avfilter_graph_create_filter(&dnCtx, afftdn, "dn", "nr=12", nullptr, graph);
    if (ret < 0)
        return failGraph(QStringLiteral("降噪：创建 afftdn 失败（%1）。").arg(avErrorText(ret)));
    ret = avfilter_graph_create_filter(&sinkCtx, sink, "out", nullptr, nullptr, graph);
    if (ret < 0)
        return failGraph(QStringLiteral("降噪：创建输出端失败（%1）。").arg(avErrorText(ret)));
    // No sample_fmts constraint on the sink: abuffer only offers
    // flt, so the negotiated format through afftdn is flt anyway;
    // the drain below verifies the format of every frame instead.
    if (avfilter_link(srcCtx, 0, dnCtx, 0) < 0)
        return failGraph(QStringLiteral("降噪：链接滤镜失败（输入端）。"));
    if (avfilter_link(dnCtx, 0, sinkCtx, 0) < 0)
        return failGraph(QStringLiteral("降噪：链接滤镜失败（输出端）。"));
    ret = avfilter_graph_config(graph, nullptr);
    if (ret < 0)
        return failGraph(QStringLiteral("降噪：配置滤镜图失败（%1）。").arg(avErrorText(ret)));

    const int inputFrames = static_cast<int>(samples.size() / 2);
    QVector<float> out;
    out.reserve(samples.size());

    auto drain = [&]() -> bool {
        AVFrame* drained = av_frame_alloc();
        if (!drained)
            return false;
        while (av_buffersink_get_frame(sinkCtx, drained) >= 0) {
            // afftdn prefers planar float: the negotiated output is
            // FLTP (data[0] = left plane, data[1] = right plane),
            // not the packed FLT fed in. Accept both and interleave.
            const bool packed = drained->format == AV_SAMPLE_FMT_FLT;
            const bool planar = drained->format == AV_SAMPLE_FMT_FLTP;
            if ((!packed && !planar) || drained->ch_layout.nb_channels != 2) {
                av_frame_unref(drained);
                av_frame_free(&drained);
                return false;
            }
            const int n = drained->nb_samples;
            const int start = out.size();
            out.resize(out.size() + n * 2);
            if (packed) {
                const float* data = reinterpret_cast<const float*>(drained->data[0]);
                std::memcpy(out.data() + start, data, static_cast<size_t>(n) * 2 * sizeof(float));
            } else {
                const float* left = reinterpret_cast<const float*>(drained->data[0]);
                const float* right = reinterpret_cast<const float*>(drained->data[1]);
                for (int i = 0; i < n; ++i) {
                    out[start + i * 2] = left[i];
                    out[start + i * 2 + 1] = right[i];
                }
            }
            av_frame_unref(drained);
        }
        av_frame_free(&drained);
        return true;
    };

    constexpr int kChunkFrames = 4096;
    int64_t pts = 0;
    int offset = 0;
    bool feedOk = true;
    while (offset < samples.size()) {
        const int framesLeft = (static_cast<int>(samples.size()) - offset) / 2;
        const int chunk = std::min(kChunkFrames, framesLeft);
        AVFrame* frame = av_frame_alloc();
        if (!frame) {
            feedOk = false;
            break;
        }
        frame->format = AV_SAMPLE_FMT_FLT;
        frame->ch_layout = AV_CHANNEL_LAYOUT_STEREO;
        frame->sample_rate = 48000;
        frame->nb_samples = chunk;
        frame->pts = pts;
        pts += chunk;
        if (av_frame_get_buffer(frame, 0) < 0) {
            av_frame_free(&frame);
            feedOk = false;
            break;
        }
        float* dst = reinterpret_cast<float*>(frame->data[0]);
        std::memcpy(dst, samples.constData() + offset,
                    static_cast<size_t>(chunk) * 2 * sizeof(float));
        offset += chunk * 2;
        ret = av_buffersrc_add_frame_flags(srcCtx, frame, AV_BUFFERSRC_FLAG_KEEP_REF);
        av_frame_free(&frame);
        if (ret < 0) {
            feedOk = false;
            break;
        }
        if (!drain()) {
            feedOk = false;
            break;
        }
    }
    if (feedOk) {
        const int eofRet = av_buffersrc_add_frame_flags(srcCtx, nullptr, 0); // EOF
        (void)eofRet;
        if (!drain())
            feedOk = false;
    }
    avfilter_graph_free(&graph);
    if (!feedOk) {
        error = QStringLiteral("降噪：滤镜图处理失败。");
        return {};
    }

    // afftdn's FFT adds a small latency, so the drained output is
    // not exactly the input length. Trim / zero-pad back to the
    // input frame count so the mix keeps its timeline alignment.
    QVector<float> aligned;
    aligned.fill(0.0f, samples.size());
    const int copyFrames = std::min(inputFrames, static_cast<int>(out.size() / 2));
    if (copyFrames > 0)
        std::memcpy(aligned.data(), out.constData(),
                    static_cast<size_t>(copyFrames) * 2 * sizeof(float));
    return aligned;
}

} // namespace catcut
