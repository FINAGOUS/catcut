// CatCut v2 — S3 camera motion: DogSC motion semantics, behaviour
// copied from the research notes (dogsc.md sections 2.6, 6.1), code
// original.
//
//   * AutoZoom: clicks are grouped by spatial + temporal proximity
//     into one stable focus; each group becomes a zoom segment that
//     holds 0.9s; manual zoom segments are kept as-is and never
//     rewritten by replanning.
//   * Spring: underdamped spring (mass / stiffness / damping), one
//     set for the screen, one for the cursor. springProgress() is the
//     normalised step response, 0 at rest, 1 at the target, with the
//     characteristic overshoot of an underdamped system.
//   * Screen 3D: position / size / tilt X / tilt Y / Z rotation /
//     perspective. The CPU renderer approximates tilt with shear
//     (documented); the projected quad here is the exact geometry.
//   * Focus blur: when a 3D segment and a zoom segment both carry a
//     focus effect at the same time, ONLY the 3D one is used — never
//     two full-frame blurs stacked (resolveFocus()).
//   * Pointer: its own track, stored separately from the video
//     (samples + style + size + still-hide delay + time calibration).
//     A cursor already burned into imported video cannot be hidden
//     or replaced — only re-recording fixes that (product note, same
//     as DogSC).
//
// All positions/sizes are normalised 0..1, top-left origin, the same
// coordinate system as the canvas (architecture doc section 4).

#pragma once

#include <QJsonObject>
#include <QList>
#include <QPointF>
#include <QString>

namespace catcut {

// --- underdamped spring ----------------------------------------------
struct SpringParams {
    double mass = 1.0;
    double stiffness = 120.0;
    double damping = 14.0; // < 2*sqrt(k*m) => underdamped (overshoot)
    bool isUnderdamped() const { return damping * damping < 4.0 * mass * stiffness; }
    QJsonObject toJson() const;
    static SpringParams fromJson(const QJsonObject& o);
};

// Normalised step response 0..1 at time `t` (seconds) into a move of
// `duration` seconds. 0 before the move, 1 (settled) after; in between
// the analytic underdamped response, which overshoots past 1 and
// settles. Overdamped/critically damped inputs degrade to a smooth
// exponential approach (never NaN, never overshoots backwards).
double springProgress(const SpringParams& spring, double t, double duration);

// --- auto zoom ---------------------------------------------------------
struct ClickEvent {
    double time = 0.0; // timeline seconds
    double x = 0.5;    // normalised
    double y = 0.5;
    QJsonObject toJson() const;
    static ClickEvent fromJson(const QJsonObject& o, bool& ok);
};

struct AutoZoomSegment {
    double start = 0.0; // timeline seconds (move-in starts here)
    double moveIn = 0.35;
    double hold = 0.9; // DogSC default hold
    double moveOut = 0.35;
    double focusX = 0.5; // stable focus, normalised, clamped to the safe margin
    double focusY = 0.5;
    double zoom = 1.6; // target scale
    bool manual = false; // manual segments survive replanning untouched
    double end() const { return start + moveIn + hold + moveOut; }
    // Zoom factor at time `t` (1.0 outside the segment).
    double zoomAt(double t, const SpringParams& spring) const;
    // Focus centre at time `t` (eases from canvas centre to the focus
    // with the same spring as the zoom).
    QPointF focusAt(double t, const SpringParams& spring) const;
    QJsonObject toJson() const;
    static AutoZoomSegment fromJson(const QJsonObject& o, bool& ok);
};

class AutoZoomPlanner {
public:
    // Grouping thresholds (DogSC: "spatial + temporal proximity").
    double spaceThreshold = 0.15; // normalised distance
    double timeThreshold = 1.5;   // seconds between clicks in one group
    double safeMargin = 0.08;     // focus never closer to the edge than this
    double defaultZoom = 1.6;
    double defaultHold = 0.9; // seconds
    SpringParams spring;      // screen spring (shared with 3D moves)

    // Groups `clicks` into stable segments. `manual` segments are
    // passed through unchanged and never merged with auto groups.
    QList<AutoZoomSegment> plan(const QList<ClickEvent>& clicks,
                                const QList<AutoZoomSegment>& manual) const;
    // Zoom + focus at time `t` across all segments (later segments
    // win when two overlap; outside any segment: zoom 1, centre focus).
    static double zoomAtTime(const QList<AutoZoomSegment>& segments, double t,
                             const SpringParams& spring);
    static QPointF focusAtTime(const QList<AutoZoomSegment>& segments, double t,
                               const SpringParams& spring);
};

// --- screen 3D ----------------------------------------------------------
struct Screen3D {
    double x = 0.5, y = 0.5; // centre, normalised
    double size = 1.0;       // multiplier
    double tiltX = 0.0;      // degrees
    double tiltY = 0.0;      // degrees
    double rotationZ = 0.0;  // degrees
    double perspective = 0.0; // 0..1, 0 = orthographic
    QJsonObject toJson() const;
    static Screen3D fromJson(const QJsonObject& o);
};

struct ScreenMotionSegment {
    QString id;
    double start = 0.0;
    double moveIn = 0.4;
    double hold = 1.0;
    double moveOut = 0.4;
    Screen3D from; // pose before the move (usually identity)
    Screen3D to;   // pose during hold
    double end() const { return start + moveIn + hold + moveOut; }
    // Interpolated pose at time `t` (spring eased; identity outside).
    Screen3D poseAt(double t, const SpringParams& spring) const;
    QJsonObject toJson() const;
    static ScreenMotionSegment fromJson(const QJsonObject& o, bool& ok);
};

// Projects the screen quad (unit square centred on the pose) through
// the 3D pose into normalised canvas coordinates. Returns the four
// corners TL, TR, BR, BL. Perspective foreshortens the far edge.
QList<QPointF> projectScreenQuad(const Screen3D& pose, double canvasAspect);

// --- focus blur: 3D wins over zoom, never both --------------------------
enum class FocusSource { None, Zoom, Screen3D };
struct FocusEffect {
    bool enabled = false;
    double centreX = 0.5, centreY = 0.5;
    double size = 0.45;    // 0..1
    double blur = 0.35;    // 0..1
    double feather = 0.5;  // 0..1
    double darken = 0.18;  // 0..1
    QJsonObject toJson() const;
    static FocusEffect fromJson(const QJsonObject& o);
};

// When both a zoom focus and a 3D focus are active at the same time,
// only the 3D one is used. Returns which one (if any) applies.
FocusSource resolveFocus(bool zoomFocusActive, bool screen3DFocusActive);

// --- pointer track -------------------------------------------------------
struct PointerSample {
    double time = 0.0;
    double x = 0.5, y = 0.5;
    bool clicked = false;
    QJsonObject toJson() const;
    static PointerSample fromJson(const QJsonObject& o, bool& ok);
};

struct PointerTrack {
    QList<PointerSample> samples; // sorted by time; stored apart from video
    QString style = QStringLiteral("arrow");
    double size = 1.0;            // multiplier
    double stillHideDelay = 0.0;  // seconds of stillness before hiding (0 = never)
    double timeOffsetMs = 0.0;    // calibration: shifts the track in time
    bool clickEffects = true;
    // Sample at timeline time `t` (time calibration applied; linear
    // interpolation between samples). Returns false when the track is
    // empty or `t` is outside it.
    bool sampleAt(double t, PointerSample& out) const;
    // Visible at `t`: inside the track and not hidden by stillness
    // (no sample movement for longer than stillHideDelay).
    bool visibleAt(double t) const;
    QJsonObject toJson() const;
    static PointerTrack fromJson(const QJsonObject& o);
};

} // namespace catcut
