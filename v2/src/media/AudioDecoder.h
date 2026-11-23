// CatCut v2 — S4 audio decoding.
//
// Decodes an audio stream (any container FFmpeg can read) to
// interleaved float PCM, 48 kHz stereo — the mixer's working format.
// Seeks to `sourceIn` first so only the used range is decoded.
// Files without an audio stream fail with a readable error (hard
// rule 3: missing metadata is never an unhandled exception).

#pragma once

#include <QVector>
#include <QString>

namespace catcut {

struct DecodedAudio {
    QVector<float> samples; // interleaved L,R float, -1..1
    int sampleRate = 48000;
    int channels = 2;

    int frameCount() const { return channels > 0 ? samples.size() / channels : 0; }
    double durationSeconds() const
    {
        return sampleRate > 0 ? static_cast<double>(frameCount()) / sampleRate : 0.0;
    }
    double rms() const; // root-mean-square over all samples, 0 when empty
    bool isSilent(double threshold = 1e-4) const { return rms() < threshold; }
};

class AudioDecoder {
public:
    // Decodes [sourceIn, sourceOut) of `path`'s audio stream.
    // Returns false with a readable `error` when the file cannot be
    // opened, has no audio stream, or nothing decodes in the range.
    static bool decodeRange(const QString& path, double sourceIn, double sourceOut,
                            DecodedAudio& out, QString& error);
    // Decodes the whole audio stream (sourceIn = 0, sourceOut = end).
    static bool decodeAll(const QString& path, DecodedAudio& out, QString& error);
};

} // namespace catcut
