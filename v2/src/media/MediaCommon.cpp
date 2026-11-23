// CatCut v2 — S1 media pipeline: shared FFmpeg helpers.

#include "media/MediaCommon.h"

extern "C" {
#include <libavutil/avutil.h>
}

namespace catcut {

QString ffmpegVersionString()
{
    return QString::fromUtf8(av_version_info());
}

} // namespace catcut
