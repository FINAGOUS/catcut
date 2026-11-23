#include "media/Loudness.h"

#include "core/AudioMix.h"
#include "media/AudioDecoder.h"
#include "media/MediaCommon.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

extern "C" {
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
}

namespace catcut {

namespace {

// Captures av_log output while loudnorm prints its JSON summary.
// loudnorm prints the measurement when the filter graph is freed,
// so the callback must be installed for the whole measurement.
std::string* g_loudnormLog = nullptr;

void loudnormLogCallback(void* /*ptr*/, int level, const char* fmt, va_list vl)
{
    if (!g_loudnormLog || level > AV_LOG_INFO)
        return;
    char buf[4096];
    vsnprintf(buf, sizeof(buf), fmt, vl);
    g_loudnormLog->append(buf);
}

// Extracts "input_i" from loudnorm's printed JSON summary.
bool parseInputI(const std::string& log, double& valueOut)
{
    const std::string key = "\"input_i\"";
    const size_t pos = log.find(key);
    if (pos == std::string::npos)
        return false;
    const size_t colon = log.find(':', pos + key.size());
    if (colon == std::string::npos)
        return false;
    const size_t start = log.find_first_of("-0123456789.", colon + 1);
    if (start == std::string::npos)
        return false;
    const size_t end = log.find_first_not_of("-0123456789.", start);
    try {
        valueOut = std::stod(log.substr(start, end - start));
    } catch (...) {
        return false;
    }
    return std::isfinite(valueOut);
}

} // namespace

double Loudness::gainToTarget(double measuredLUFS)
{
    if (!std::isfinite(measuredLUFS))
        return 0.0;
    return std::clamp(kTargetLUFS - measuredLUFS, -30.0, 30.0);
}

double Loudness::measureIntegrated(const QVector<float>& samples, QString& error)
{
    if (samples.isEmpty() || (samples.size() % 2) != 0) {
        error = QStringLiteral("响度测量：输入为空或不是立体声交错采样。");
        return std::numeric_limits<double>::quiet_NaN();
    }
    const AVFilter* abuffer = avfilter_get_by_name("abuffer");
    const AVFilter* loudnorm = avfilter_get_by_name("loudnorm");
    const AVFilter* sink = avfilter_get_by_name("anullsink");
    if (!abuffer || !loudnorm || !sink) {
        error = QStringLiteral("响度测量：FFmpeg 缺少 abuffer/loudnorm/anullsink 滤镜。");
        return std::numeric_limits<double>::quiet_NaN();
    }

    AVFilterGraph* graph = avfilter_graph_alloc();
    if (!graph) {
        error = QStringLiteral("响度测量：分配滤镜图失败。");
        return std::numeric_limits<double>::quiet_NaN();
    }

    AVFilterContext* srcCtx = nullptr;
    AVFilterContext* normCtx = nullptr;
    AVFilterContext* sinkCtx = nullptr;
    double result = std::numeric_limits<double>::quiet_NaN();
    std::string capturedLog;

    auto fail = [&](const QString& message) {
        error = message;
        if (srcCtx || normCtx || sinkCtx) {
            // fall through to graph free below
        }
    };

    int ret = avfilter_graph_create_filter(
        &srcCtx, abuffer, "in",
        "sample_rate=48000:sample_fmt=flt:channel_layout=stereo:time_base=1/48000",
        nullptr, graph);
    if (ret < 0) {
        fail(QStringLiteral("响度测量：创建 abuffer 失败（%1）。").arg(avErrorText(ret)));
        avfilter_graph_free(&graph);
        return result;
    }
    ret = avfilter_graph_create_filter(&normCtx, loudnorm, "norm",
                                       "I=-16:TP=-1.5:LRA=11:print_format=json",
                                       nullptr, graph);
    if (ret < 0) {
        fail(QStringLiteral("响度测量：创建 loudnorm 失败（%1）。").arg(avErrorText(ret)));
        avfilter_graph_free(&graph);
        return result;
    }
    ret = avfilter_graph_create_filter(&sinkCtx, sink, "out", nullptr, nullptr, graph);
    if (ret < 0) {
        fail(QStringLiteral("响度测量：创建输出端失败（%1）。").arg(avErrorText(ret)));
        avfilter_graph_free(&graph);
        return result;
    }
    ret = avfilter_link(srcCtx, 0, normCtx, 0);
    if (ret < 0) {
        fail(QStringLiteral("响度测量：链接滤镜失败（%1）。").arg(avErrorText(ret)));
        avfilter_graph_free(&graph);
        return result;
    }
    ret = avfilter_link(normCtx, 0, sinkCtx, 0);
    if (ret < 0) {
        fail(QStringLiteral("响度测量：链接滤镜失败（%1）。").arg(avErrorText(ret)));
        avfilter_graph_free(&graph);
        return result;
    }
    ret = avfilter_graph_config(graph, nullptr);
    if (ret < 0) {
        fail(QStringLiteral("响度测量：配置滤镜图失败（%1）。").arg(avErrorText(ret)));
        avfilter_graph_free(&graph);
        return result;
    }

    // Install the log capture for the feed + drain + free sequence:
    // loudnorm prints its JSON summary when the graph is freed.
    // (libavutil has no av_log_get_callback: restore with nullptr,
    // which resets to the default callback.)
    const int previousLogLevel = av_log_get_level();
    av_log_set_level(AV_LOG_INFO);
    capturedLog.clear();
    g_loudnormLog = &capturedLog;

    constexpr int kChunkFrames = 4096;
    int64_t pts = 0;
    int offset = 0;
    bool feedOk = true;
    while (offset < samples.size()) {
        const int framesLeft = (samples.size() - offset) / 2;
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
        // Drain whatever the filter produced.
        AVFrame* drained = av_frame_alloc();
        while (drained && av_buffersink_get_frame(sinkCtx, drained) >= 0)
            av_frame_unref(drained);
        av_frame_free(&drained);
    }
    if (feedOk) {
        const int eofRet = av_buffersrc_add_frame_flags(srcCtx, nullptr, 0); // EOF
        (void)eofRet;
        AVFrame* drained = av_frame_alloc();
        while (drained && av_buffersink_get_frame(sinkCtx, drained) >= 0)
            av_frame_unref(drained);
        av_frame_free(&drained);
    }

    avfilter_graph_free(&graph); // loudnorm prints its JSON here
    g_loudnormLog = nullptr;
    av_log_set_callback(nullptr); // back to the default callback
    av_log_set_level(previousLogLevel);

    if (!feedOk) {
        error = QStringLiteral("响度测量：向滤镜图送采样失败。");
        return result;
    }
    double measured = 0.0;
    if (!parseInputI(capturedLog, measured)) {
        error = QStringLiteral("响度测量：loudnorm 未输出可解析的测量结果。");
        return result;
    }
    return measured;
}

double Loudness::measureFile(const QString& path, QString& error)
{
    DecodedAudio audio;
    if (!AudioDecoder::decodeAll(path, audio, error))
        return std::numeric_limits<double>::quiet_NaN();
    return measureIntegrated(audio.samples, error);
}

QVector<float> Loudness::normalizeToTarget(const QVector<float>& samples,
                                           double& measuredBefore,
                                           double& appliedGainDb,
                                           QString& error)
{
    measuredBefore = std::numeric_limits<double>::quiet_NaN();
    appliedGainDb = 0.0;
    const double measured = measureIntegrated(samples, error);
    if (!std::isfinite(measured))
        return {};
    measuredBefore = measured;
    appliedGainDb = gainToTarget(measured);
    const double linear = dbToLinear(appliedGainDb);
    QVector<float> out = samples;
    for (float& v : out)
        v = static_cast<float>(std::clamp(static_cast<double>(v) * linear, -1.0, 1.0));
    return out;
}

} // namespace catcut
