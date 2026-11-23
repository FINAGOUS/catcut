// CatCut v2 — S6 audio denoise (FFmpeg afftdn, export effect chain).
//
// The S4 doc specified afftdn as the denoise scheme but left it as a
// "pre-process the source file, then import" manual step: the export
// pipeline had no denoise switch. S6 wires it in as a real export
// option (ExportOptions::denoise, off by default, checkbox in the
// export dialog): the mixed timeline audio is run through an
// abuffer -> afftdn -> abuffersink filter graph before loudness
// normalisation, so the exported file's audio really went through
// afftdn. verify-s6 proves it with a number, not with the switch
// existing: the same noisy timeline exported twice, the denoised
// file's 8 kHz high-pass RMS is lower.
//
// Honest limits, measured on afftdn with default settings
// (nr=12, noise floor -50 dB):
// - afftdn only treats content near its noise floor as noise. Quiet
//   hiss (white noise ~0.02 amplitude under a 0.5 tone) is reduced:
//   8 kHz high-pass RMS ratio ~0.77 on FFmpeg 8.1, ~0.89 on FFmpeg
//   6.1 (same signal, C++ filter-graph probe). Loud broadband noise
//   (~0.3 amplitude) sits far above the -50 dB floor and is barely
//   touched (ratio ~1.0). So this is a hiss / room-tone reducer,
//   not a "remove any noise" button; the dialog tooltip says so.
// - The tone itself is preserved: a 440 Hz tone at 0.5 keeps its
//   level (-30.2 dB -> -30.3 dB through afftdn).
// - afftdn outputs planar float (FLTP) even when fed packed float:
//   the drain interleaves both formats. Its FFT adds a small
//   latency; the output is trimmed / zero-padded back to exactly
//   the input frame count so the mix keeps its timeline alignment.

#pragma once

#include <QVector>
#include <QString>

namespace catcut {

class AudioDenoise {
public:
    // True when the afftdn filter is present in this FFmpeg build.
    static bool isAvailable();

    // Runs interleaved stereo float 48 kHz samples through afftdn
    // (nr=12, defaults otherwise). Returns the denoised samples at
    // exactly the input length (trimmed / zero-padded), or an empty
    // vector + readable `error` when the input is empty / not stereo
    // or the filter graph cannot be built. Never throws.
    static QVector<float> applyAfftdn(const QVector<float>& samples, QString& error);
};

} // namespace catcut
