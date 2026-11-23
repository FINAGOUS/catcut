#include "core/CameraMotion.h"
#include <QJsonArray>

#include <QtMath>
#include <algorithm>
#include <cmath>

namespace catcut {

namespace {

double clampd(double v, double lo, double hi) { return std::clamp(v, lo, hi); }

// Smoothstep-free ease used only as a fallback for the (invalid)
// overdamped case: monotone, 0 at 0, 1 at 1.
double smooth01(double u)
{
    u = clampd(u, 0.0, 1.0);
    return u * u * (3.0 - 2.0 * u);
}

} // namespace

// ---------------------------------------------------------------- spring

QJsonObject SpringParams::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("mass"), mass);
    o.insert(QStringLiteral("stiffness"), stiffness);
    o.insert(QStringLiteral("damping"), damping);
    return o;
}

SpringParams SpringParams::fromJson(const QJsonObject& o)
{
    SpringParams s;
    s.mass = std::max(0.01, o.value(QStringLiteral("mass")).toDouble(1.0));
    s.stiffness = std::max(1.0, o.value(QStringLiteral("stiffness")).toDouble(120.0));
    s.damping = std::max(0.0, o.value(QStringLiteral("damping")).toDouble(14.0));
    return s;
}

double springProgress(const SpringParams& spring, double t, double duration)
{
    if (t <= 0.0)
        return 0.0;
    if (duration <= 0.0 || t >= duration)
        return 1.0;
    const double u = t / duration;
    const double m = std::max(0.01, spring.mass);
    const double k = std::max(1.0, spring.stiffness);
    const double c = std::max(0.0, spring.damping);
    const double omega0 = std::sqrt(k / m);
    const double zeta = c / (2.0 * std::sqrt(k * m));
    if (zeta >= 1.0) {
        // Overdamped / critically damped: no overshoot, smooth approach.
        return smooth01(u);
    }
    // Underdamped analytic step response:
    //   1 - e^(-zeta*w0*t') * (cos(wd*t') + zeta/sqrt(1-zeta^2) * sin(wd*t'))
    // with t' stretched so the response settles near the end of the
    // move (omega0 * duration radians of oscillation).
    const double wd = omega0 * std::sqrt(1.0 - zeta * zeta);
    const double tPrime = u * duration;
    const double decay = std::exp(-zeta * omega0 * tPrime);
    const double response = 1.0 - decay * (std::cos(wd * tPrime)
        + (zeta / std::sqrt(1.0 - zeta * zeta)) * std::sin(wd * tPrime));
    // The analytic response overshoots above 1 mid-move (that is the
    // point of an underdamped spring) and settles to 1; clamp only the
    // wild tail so a huge overshoot can never invert the picture.
    return clampd(response, -0.5, 1.5);
}

// ---------------------------------------------------------------- clicks

QJsonObject ClickEvent::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("time"), time);
    o.insert(QStringLiteral("x"), x);
    o.insert(QStringLiteral("y"), y);
    return o;
}

ClickEvent ClickEvent::fromJson(const QJsonObject& o, bool& ok)
{
    ClickEvent c;
    ok = o.contains(QStringLiteral("time"));
    if (!ok)
        return c;
    c.time = o.value(QStringLiteral("time")).toDouble();
    c.x = clampd(o.value(QStringLiteral("x")).toDouble(0.5), 0.0, 1.0);
    c.y = clampd(o.value(QStringLiteral("y")).toDouble(0.5), 0.0, 1.0);
    return c;
}

double AutoZoomSegment::zoomAt(double t, const SpringParams& spring) const
{
    if (t < start || t >= end())
        return 1.0;
    double p = 1.0;
    if (t < start + moveIn)
        p = springProgress(spring, t - start, moveIn);
    else if (t >= end() - moveOut)
        p = 1.0 - springProgress(spring, t - (end() - moveOut), moveOut);
    // Overshoot on the way in is allowed (spring); on the way out the
    // response is mirrored so the zoom settles back to 1, not below.
    p = clampd(p, 0.0, 1.5);
    return 1.0 + (zoom - 1.0) * p;
}

QPointF AutoZoomSegment::focusAt(double t, const SpringParams& spring) const
{
    if (t < start || t >= end())
        return QPointF(0.5, 0.5);
    double p = 1.0;
    if (t < start + moveIn)
        p = springProgress(spring, t - start, moveIn);
    else if (t >= end() - moveOut)
        p = 1.0 - springProgress(spring, t - (end() - moveOut), moveOut);
    p = clampd(p, 0.0, 1.0);
    return QPointF(0.5 + (focusX - 0.5) * p, 0.5 + (focusY - 0.5) * p);
}

QJsonObject AutoZoomSegment::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("start"), start);
    o.insert(QStringLiteral("moveIn"), moveIn);
    o.insert(QStringLiteral("hold"), hold);
    o.insert(QStringLiteral("moveOut"), moveOut);
    o.insert(QStringLiteral("focusX"), focusX);
    o.insert(QStringLiteral("focusY"), focusY);
    o.insert(QStringLiteral("zoom"), zoom);
    o.insert(QStringLiteral("manual"), manual);
    return o;
}

AutoZoomSegment AutoZoomSegment::fromJson(const QJsonObject& o, bool& ok)
{
    AutoZoomSegment s;
    ok = o.contains(QStringLiteral("start"));
    if (!ok)
        return s;
    s.start = o.value(QStringLiteral("start")).toDouble();
    s.moveIn = std::max(0.05, o.value(QStringLiteral("moveIn")).toDouble(0.35));
    s.hold = std::max(0.0, o.value(QStringLiteral("hold")).toDouble(0.9));
    s.moveOut = std::max(0.05, o.value(QStringLiteral("moveOut")).toDouble(0.35));
    s.focusX = clampd(o.value(QStringLiteral("focusX")).toDouble(0.5), 0.0, 1.0);
    s.focusY = clampd(o.value(QStringLiteral("focusY")).toDouble(0.5), 0.0, 1.0);
    s.zoom = std::max(1.0, o.value(QStringLiteral("zoom")).toDouble(1.6));
    s.manual = o.value(QStringLiteral("manual")).toBool(false);
    return s;
}

QList<AutoZoomSegment> AutoZoomPlanner::plan(const QList<ClickEvent>& clicks,
                                             const QList<AutoZoomSegment>& manual) const
{
    QList<AutoZoomSegment> out = manual; // manual segments pass through untouched
    if (clicks.isEmpty())
        return out;
    QList<ClickEvent> sorted = clicks;
    std::sort(sorted.begin(), sorted.end(),
              [](const ClickEvent& a, const ClickEvent& b) { return a.time < b.time; });
    // Group: a click joins the current group when it is close in space
    // AND close in time to the group's last click.
    struct Group {
        QList<ClickEvent> clicks;
    };
    QList<Group> groups;
    for (const ClickEvent& c : sorted) {
        if (!groups.isEmpty()) {
            const ClickEvent& last = groups.last().clicks.last();
            const double dist = std::hypot(c.x - last.x, c.y - last.y);
            if (dist <= spaceThreshold && (c.time - last.time) <= timeThreshold) {
                groups.last().clicks.append(c);
                continue;
            }
        }
        groups.append(Group{{c}});
    }
    for (const Group& g : groups) {
        // Stable focus: centroid of the group, clamped to the safe margin.
        double fx = 0.0, fy = 0.0;
        for (const ClickEvent& c : g.clicks) {
            fx += c.x;
            fy += c.y;
        }
        fx /= g.clicks.size();
        fy /= g.clicks.size();
        AutoZoomSegment seg;
        seg.start = g.clicks.first().time;
        seg.moveIn = 0.35;
        seg.hold = defaultHold;
        seg.moveOut = 0.35;
        seg.focusX = clampd(fx, safeMargin, 1.0 - safeMargin);
        seg.focusY = clampd(fy, safeMargin, 1.0 - safeMargin);
        seg.zoom = defaultZoom;
        seg.manual = false;
        out.append(seg);
    }
    std::sort(out.begin(), out.end(),
              [](const AutoZoomSegment& a, const AutoZoomSegment& b) { return a.start < b.start; });
    return out;
}

double AutoZoomPlanner::zoomAtTime(const QList<AutoZoomSegment>& segments, double t,
                                   const SpringParams& spring)
{
    double zoom = 1.0;
    for (const AutoZoomSegment& s : segments) {
        if (t >= s.start && t < s.end())
            zoom = s.zoomAt(t, spring); // later segments win on overlap
    }
    return zoom;
}

QPointF AutoZoomPlanner::focusAtTime(const QList<AutoZoomSegment>& segments, double t,
                                     const SpringParams& spring)
{
    QPointF focus(0.5, 0.5);
    for (const AutoZoomSegment& s : segments) {
        if (t >= s.start && t < s.end())
            focus = s.focusAt(t, spring);
    }
    return focus;
}

// ---------------------------------------------------------------- 3D

QJsonObject Screen3D::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("x"), x);
    o.insert(QStringLiteral("y"), y);
    o.insert(QStringLiteral("size"), size);
    o.insert(QStringLiteral("tiltX"), tiltX);
    o.insert(QStringLiteral("tiltY"), tiltY);
    o.insert(QStringLiteral("rotationZ"), rotationZ);
    o.insert(QStringLiteral("perspective"), perspective);
    return o;
}

Screen3D Screen3D::fromJson(const QJsonObject& o)
{
    Screen3D s;
    s.x = clampd(o.value(QStringLiteral("x")).toDouble(0.5), 0.0, 1.0);
    s.y = clampd(o.value(QStringLiteral("y")).toDouble(0.5), 0.0, 1.0);
    s.size = clampd(o.value(QStringLiteral("size")).toDouble(1.0), 0.05, 4.0);
    s.tiltX = clampd(o.value(QStringLiteral("tiltX")).toDouble(0.0), -89.0, 89.0);
    s.tiltY = clampd(o.value(QStringLiteral("tiltY")).toDouble(0.0), -89.0, 89.0);
    s.rotationZ = o.value(QStringLiteral("rotationZ")).toDouble(0.0);
    s.perspective = clampd(o.value(QStringLiteral("perspective")).toDouble(0.0), 0.0, 1.0);
    return s;
}

Screen3D ScreenMotionSegment::poseAt(double t, const SpringParams& spring) const
{
    if (t < start || t >= end())
        return from;
    double p = 1.0;
    if (t < start + moveIn)
        p = clampd(springProgress(spring, t - start, moveIn), 0.0, 1.0);
    else if (t >= end() - moveOut)
        p = 1.0 - clampd(springProgress(spring, t - (end() - moveOut), moveOut), 0.0, 1.0);
    Screen3D pose;
    pose.x = from.x + (to.x - from.x) * p;
    pose.y = from.y + (to.y - from.y) * p;
    pose.size = from.size + (to.size - from.size) * p;
    pose.tiltX = from.tiltX + (to.tiltX - from.tiltX) * p;
    pose.tiltY = from.tiltY + (to.tiltY - from.tiltY) * p;
    pose.rotationZ = from.rotationZ + (to.rotationZ - from.rotationZ) * p;
    pose.perspective = from.perspective + (to.perspective - from.perspective) * p;
    return pose;
}

QJsonObject ScreenMotionSegment::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("start"), start);
    o.insert(QStringLiteral("moveIn"), moveIn);
    o.insert(QStringLiteral("hold"), hold);
    o.insert(QStringLiteral("moveOut"), moveOut);
    o.insert(QStringLiteral("from"), from.toJson());
    o.insert(QStringLiteral("to"), to.toJson());
    return o;
}

ScreenMotionSegment ScreenMotionSegment::fromJson(const QJsonObject& o, bool& ok)
{
    ScreenMotionSegment s;
    ok = o.contains(QStringLiteral("id")) && o.contains(QStringLiteral("start"));
    if (!ok)
        return s;
    s.id = o.value(QStringLiteral("id")).toString();
    s.start = o.value(QStringLiteral("start")).toDouble();
    s.moveIn = std::max(0.05, o.value(QStringLiteral("moveIn")).toDouble(0.4));
    s.hold = std::max(0.0, o.value(QStringLiteral("hold")).toDouble(1.0));
    s.moveOut = std::max(0.05, o.value(QStringLiteral("moveOut")).toDouble(0.4));
    s.from = Screen3D::fromJson(o.value(QStringLiteral("from")).toObject());
    s.to = Screen3D::fromJson(o.value(QStringLiteral("to")).toObject());
    ok = s.end() > s.start && !s.id.isEmpty();
    return s;
}

QList<QPointF> projectScreenQuad(const Screen3D& pose, double canvasAspect)
{
    // Unit quad in canvas space (x normalised, y normalised by aspect so
    // a square stays square on screen): corners before the pose.
    const double hw = 0.5 * pose.size;
    const double hh = 0.5 * pose.size / std::max(0.01, canvasAspect);
    QList<QPointF> corners = {QPointF(-hw, -hh), QPointF(hw, -hh), QPointF(hw, hh), QPointF(-hw, hh)};
    const double radX = pose.tiltX * M_PI / 180.0;
    const double radY = pose.tiltY * M_PI / 180.0;
    const double radZ = pose.rotationZ * M_PI / 180.0;
    const double cosZ = std::cos(radZ), sinZ = std::sin(radZ);
    QList<QPointF> out;
    for (QPointF p : corners) {
        // Z rotation (in-plane).
        double x = p.x() * cosZ - p.y() * sinZ;
        double y = p.x() * sinZ + p.y() * cosZ;
        // Tilt: rotate around the X axis (foreshortens Y) and Y axis
        // (foreshortens X). The far edge shrinks with perspective.
        const double persp = pose.perspective;
        const double depthY = 1.0 + persp * std::sin(radX) * (y / std::max(hh, 1e-6));
        const double depthX = 1.0 + persp * std::sin(radY) * (x / std::max(hw, 1e-6));
        x = x * std::cos(radY) / std::max(0.05, depthX);
        y = y * std::cos(radX) / std::max(0.05, depthY);
        out.append(QPointF(pose.x + x, pose.y + y));
    }
    return out;
}

// ---------------------------------------------------------------- focus

FocusSource resolveFocus(bool zoomFocusActive, bool screen3DFocusActive)
{
    if (screen3DFocusActive)
        return FocusSource::Screen3D;
    if (zoomFocusActive)
        return FocusSource::Zoom;
    return FocusSource::None;
}

QJsonObject FocusEffect::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("enabled"), enabled);
    o.insert(QStringLiteral("centreX"), centreX);
    o.insert(QStringLiteral("centreY"), centreY);
    o.insert(QStringLiteral("size"), size);
    o.insert(QStringLiteral("blur"), blur);
    o.insert(QStringLiteral("feather"), feather);
    o.insert(QStringLiteral("darken"), darken);
    return o;
}

FocusEffect FocusEffect::fromJson(const QJsonObject& o)
{
    FocusEffect f;
    f.enabled = o.value(QStringLiteral("enabled")).toBool(false);
    f.centreX = clampd(o.value(QStringLiteral("centreX")).toDouble(0.5), 0.0, 1.0);
    f.centreY = clampd(o.value(QStringLiteral("centreY")).toDouble(0.5), 0.0, 1.0);
    f.size = clampd(o.value(QStringLiteral("size")).toDouble(0.45), 0.0, 1.0);
    f.blur = clampd(o.value(QStringLiteral("blur")).toDouble(0.35), 0.0, 1.0);
    f.feather = clampd(o.value(QStringLiteral("feather")).toDouble(0.5), 0.0, 1.0);
    f.darken = clampd(o.value(QStringLiteral("darken")).toDouble(0.18), 0.0, 1.0);
    return f;
}

// ---------------------------------------------------------------- pointer

QJsonObject PointerSample::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("time"), time);
    o.insert(QStringLiteral("x"), x);
    o.insert(QStringLiteral("y"), y);
    o.insert(QStringLiteral("clicked"), clicked);
    return o;
}

PointerSample PointerSample::fromJson(const QJsonObject& o, bool& ok)
{
    PointerSample s;
    ok = o.contains(QStringLiteral("time"));
    if (!ok)
        return s;
    s.time = o.value(QStringLiteral("time")).toDouble();
    s.x = clampd(o.value(QStringLiteral("x")).toDouble(0.5), 0.0, 1.0);
    s.y = clampd(o.value(QStringLiteral("y")).toDouble(0.5), 0.0, 1.0);
    s.clicked = o.value(QStringLiteral("clicked")).toBool(false);
    return s;
}

bool PointerTrack::sampleAt(double t, PointerSample& out) const
{
    if (samples.isEmpty())
        return false;
    const double tt = t - timeOffsetMs / 1000.0; // calibration shifts the track
    if (tt < samples.first().time || tt > samples.last().time)
        return false;
    for (int i = 0; i + 1 < samples.size(); ++i) {
        const PointerSample& a = samples[i];
        const PointerSample& b = samples[i + 1];
        if (tt >= a.time && tt <= b.time) {
            const double span = b.time - a.time;
            const double f = span > 0.0 ? (tt - a.time) / span : 0.0;
            out.time = tt;
            out.x = a.x + (b.x - a.x) * f;
            out.y = a.y + (b.y - a.y) * f;
            out.clicked = tt - a.time < 0.15 ? a.clicked : b.clicked;
            return true;
        }
    }
    out = samples.last();
    return true;
}

bool PointerTrack::visibleAt(double t) const
{
    PointerSample s;
    if (!sampleAt(t, s))
        return false;
    if (stillHideDelay <= 0.0)
        return true;
    const double tt = t - timeOffsetMs / 1000.0;
    // Still = no sample movement for longer than the delay.
    double lastMove = samples.first().time;
    for (int i = 1; i < samples.size(); ++i) {
        if (samples[i].time > tt)
            break;
        if (std::hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y) > 0.002)
            lastMove = samples[i].time;
    }
    return (tt - lastMove) < stillHideDelay;
}

QJsonObject PointerTrack::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("style"), style);
    o.insert(QStringLiteral("size"), size);
    o.insert(QStringLiteral("stillHideDelay"), stillHideDelay);
    o.insert(QStringLiteral("timeOffsetMs"), timeOffsetMs);
    o.insert(QStringLiteral("clickEffects"), clickEffects);
    QJsonArray arr;
    for (const PointerSample& s : samples)
        arr.append(s.toJson());
    o.insert(QStringLiteral("samples"), arr);
    return o;
}

PointerTrack PointerTrack::fromJson(const QJsonObject& o)
{
    PointerTrack track;
    track.style = o.value(QStringLiteral("style")).toString(QStringLiteral("arrow"));
    track.size = clampd(o.value(QStringLiteral("size")).toDouble(1.0), 0.1, 4.0);
    track.stillHideDelay = std::max(0.0, o.value(QStringLiteral("stillHideDelay")).toDouble(0.0));
    track.timeOffsetMs = clampd(o.value(QStringLiteral("timeOffsetMs")).toDouble(0.0), -5000.0, 5000.0);
    track.clickEffects = o.value(QStringLiteral("clickEffects")).toBool(true);
    const QJsonArray arr = o.value(QStringLiteral("samples")).toArray();
    for (const QJsonValue& v : arr) {
        bool ok = false;
        PointerSample s = PointerSample::fromJson(v.toObject(), ok);
        if (ok)
            track.samples.append(s);
    }
    std::sort(track.samples.begin(), track.samples.end(),
              [](const PointerSample& a, const PointerSample& b) { return a.time < b.time; });
    return track;
}

} // namespace catcut
