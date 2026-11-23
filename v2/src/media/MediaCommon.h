// CatCut v2 — S1 media pipeline: shared FFmpeg helpers.
// Only used inside src/media; not a public API.

#pragma once

#include <QString>

extern "C" {
#include <libavutil/error.h>
}

namespace catcut {

// Human-readable text for an FFmpeg error code (never empty).
inline QString avErrorText(int errnum)
{
    char buf[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(errnum, buf, sizeof(buf));
    const QString text = QString::fromUtf8(buf).trimmed();
    return text.isEmpty() ? QStringLiteral("未知错误 (%1)").arg(errnum) : text;
}

// FFmpeg runtime version, e.g. "8.0". Used by the self-test log.
QString ffmpegVersionString();

} // namespace catcut
