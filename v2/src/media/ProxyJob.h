// CatCut v2 — S1 media pipeline: background proxy generation.
//
// Proxies are preview-only: export always re-links the original media
// (hard rule 4). A missing proxy is a hard error — the UI shows it and
// playback must not silently fall back to the original (that rule is
// enforced by the timeline in S2; here ProxyJob guarantees it never
// leaves a stale/partial proxy file behind: failures delete the output).
//
// Proxy encoder selection (runtime probe, in order):
//   libopenh264 -> libvpx-vp9 -> mpeg4
// libx264/libx265 (GPL) are never used; H.264/H.265 encoding in the
// release build goes through hardware encoders (S4).

#pragma once

#include <QString>
#include <functional>
#include <thread>
#include <atomic>

namespace catcut {

class ProxyJob {
public:
    using ProgressCallback = std::function<void(double fraction, int framesDone, int framesTotal)>;
    using FinishedCallback = std::function<void(bool ok, const QString& error, const QString& encoderUsed)>;

    ProxyJob();
    ~ProxyJob();

    ProxyJob(const ProxyJob&) = delete;
    ProxyJob& operator=(const ProxyJob&) = delete;

    // Returns the first available proxy encoder, or empty when none of
    // libopenh264 / libvpx-vp9 / mpeg4 is present in this FFmpeg build.
    static QString selectEncoder();
    static bool encoderAvailable(const QString& name);

    // Synchronous generation. `targetHeight` is 720 or 540; the width is
    // derived from the source aspect ratio (even values only, as required
    // by the encoders). On success `encoderUsed` holds the encoder that
    // was actually selected. On failure the partial output is deleted.
    bool generate(const QString& sourcePath, const QString& proxyPath,
                  int targetHeight, QString& error, QString& encoderUsed,
                  const ProgressCallback& progress = nullptr);

    // Async: runs generate() on a worker thread and invokes `finished`
    // (from the worker thread — the caller must hop to the GUI thread
    // before touching widgets). `wait()` joins the thread.
    void startAsync(const QString& sourcePath, const QString& proxyPath,
                    int targetHeight, const FinishedCallback& finished,
                    const ProgressCallback& progress = nullptr);
    void wait();
    bool isRunning() const { return m_running.load(); }

private:
    std::thread m_thread;
    std::atomic<bool> m_running{false};
};

} // namespace catcut
