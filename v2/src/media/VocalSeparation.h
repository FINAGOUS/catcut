// CatCut v2 — S4 vocal separation: pipeline hook, honest error.
//
// The old TS engine (vocalsep.ts) ran Demucs (Python + PyTorch) as
// an external helper: the engine owned the interface + validation,
// the separation itself ran in scripts/vocalsep.py. v2 keeps the
// same shape: this class is the interface + validation + wiring,
// and it reports honestly that no separation backend is connected
// yet instead of returning fake stems. Wiring a real backend means:
// install Demucs (see setupInstructions), run it on the source,
// and return the two stems — the ExportPipeline mix already accepts
// a stem file as an ordinary audio clip, so no other code changes.
//
// Do NOT "implement" this by filtering (e.g. a centre-channel cut):
// that is not vocal separation and must not be shipped as if it were.

#pragma once

#include <QString>

namespace catcut {

class VocalSeparator {
public:
    // No backend is vendored in S4: always false. Kept as a query so
    // callers (and the self-test) can branch on it.
    static bool isAvailable();

    // Attempts a separation. Always fails in S4 with an honest error
    // (no backend connected) + the setup instructions. Never returns
    // empty or fabricated stems.
    static bool separate(const QString& sourcePath, const QString& outDir,
                         QString& vocalsPath, QString& accompanimentPath,
                         QString& error);

    // Demucs setup instructions (mirrors the old engine's DEMUCS_SETUP).
    static QString setupInstructions();
};

} // namespace catcut
