// CatCut v2 — S4 auto transcription: pipeline hook, honest error.
//
// The old TS engine (transcribe.ts) ran faster-whisper (Python, CPU
// int8) as an external helper and converted its Traditional output to
// Simplified before burning. The v2 plan (task brief) is whisper.cpp
// vendored as a source library. That vendoring is NOT done in S4:
// pulling a third-party C++ tree into the CI build without a clean
// compile proof would risk the whole export pipeline, so this class
// is the interface + hook only — it fails honestly with the setup
// instructions instead of returning fabricated subtitles.
//
// Wiring the real backend means: vendor whisper.cpp (or a
// faster-whisper helper behind the same interface), decode the audio
// to 16 kHz mono PCM, transcribe to timestamped segments, convert
// Traditional -> Simplified, and fill a SubtitleTrack. The subtitle
// model, SRT I/O and burn-in already exist; transcription only has
// to produce SubtitleItems.

#pragma once

#include <QList>
#include <QString>

namespace catcut {

struct SubtitleItem;

class AutoTranscriber {
public:
    // No backend is vendored in S4: always false.
    static bool isAvailable();

    // Attempts transcription. Always fails in S4 with an honest error
    // (no model connected) + the setup instructions. Never returns
    // fabricated subtitle items.
    static bool transcribe(const QString& audioPath, const QString& language,
                           QList<SubtitleItem>& itemsOut, QString& error);

    // whisper.cpp / faster-whisper setup instructions.
    static QString setupInstructions();
};

} // namespace catcut
