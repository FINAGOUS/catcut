// CatCut v2 — S6 vocal separation: centre-channel elimination.
//
// S4 left this as a hook with an honest error ("no backend") and a
// note saying "do NOT implement this by filtering (e.g. a centre
// -channel cut): that is not vocal separation". S6 changes the scope
// deliberately, with the user's sign-off: a Demucs-grade AI
// separation is NOT what this ships — it is too heavy for this round
// (Python + PyTorch + ~400 MB of weights, see setupInstructions).
// What ships instead is the classic out-of-phase stereo (OOPS)
// centre-channel elimination, labelled honestly everywhere as
// "中置声道消除（非 AI）":
//
//   music L = (L - R) / 2,  music R = (R - L) / 2
//   centre  = (L + R) / 2   (both channels; the extracted centre
//                             content — voice + centred instruments)
//
// Anything panned dead centre cancels out of the music track; the
// centre file is what was removed, not an isolated vocal. It works
// well on studio mixes where the lead vocal sits centre and the
// instruments are spread, and poorly on mono sources (nothing to
// cancel: a mono file fails with a readable error) and on mixes
// where the vocal is not centred. The UI, the docs and the self-test
// all say this plainly; nothing here claims to be AI separation.
//
// separate() returns two WAVs in `outDir`:
//   <base>_music.wav   — the accompaniment (centre removed)
//   <base>_center.wav  — the extracted centre content
// `vocalsPath` is set to the centre file; callers must NOT present
// it as isolated vocals. Demucs remains the documented follow-up
// for real AI separation.

#pragma once

#include <QString>

namespace catcut {

class VocalSeparator {
public:
    // S6: the built-in centre-elimination backend is always present
    // (pure sample math on the decoded audio, no model, no download).
    static bool isAvailable();

    // Honest method label, shown in the UI and the docs.
    // "中置声道消除（非 AI）" — never "AI 人声分离".
    static QString methodDescription();

    // Separates `sourcePath` (must be stereo) into a music track and
    // a centre-content track in `outDir` (created if needed).
    // Returns false + a readable `error` when the file is missing,
    // has no decodable audio, or is not stereo. Never returns fake
    // or empty stems on success: both files are written and
    // non-silent-checked by the caller-facing self-test.
    static bool separate(const QString& sourcePath, const QString& outDir,
                         QString& vocalsPath, QString& accompanimentPath,
                         QString& error);

    // Demucs (AI) setup instructions — the follow-up route for real
    // AI separation, NOT what separate() runs today.
    static QString setupInstructions();
};

} // namespace catcut
