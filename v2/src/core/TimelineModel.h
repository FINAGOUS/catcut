// CatCut v2 — S2 timeline: magnetic timeline model (platform-free).
//
// FCP-style magnetic model, trimmed to the demo (architecture doc
// section 7, research doc section 1):
//   * Primary storyline: ripple by default — insert/delete close up,
//     no gaps are ever left on the primary track.
//   * Connected clips: B-roll / titles / music / SFX anchored to a
//     *moment* of the primary storyline (an anchor clip + an offset
//     inside it), not to an absolute timecode. When the primary clip
//     moves or is trimmed, connected clips follow and never drift.
//   * Secondary storylines: a group of connected clips packed into one
//     unit that moves as a whole.
//   * Disconnect escape hatch, from day one: disconnecting a clip
//     freezes it at its current absolute position (FCP only added
//     this in 13.0; v2 has it from the start).
//   * Roles: clips carry a role name (see Roles.h); lanes and per-role
//     stem export (S4) are derived from roles, never from track
//     numbers.
//
// Times are double seconds. Primary clips are kept sorted and
// contiguous from 0. All operations are total: they either complete
// or leave the model unchanged (a failed op returns false and does
// not half-apply).

#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QMap>
#include <QPointF>
#include <QString>

#include "core/BeautyKeying.h"
#include "core/CameraMotion.h"
#include "core/CanvasStyle.h"
#include "core/ColorGrade.h"
#include "core/Keyframes.h"
#include "core/Roles.h"
#include "core/Transitions.h"

namespace catcut {

enum class ClipKind {
    Video,
    Audio,
    Title
};

QString clipKindName(ClipKind kind);
ClipKind clipKindFromName(const QString& name, ClipKind fallback = ClipKind::Video);

struct Clip {
    QString id;              // stable id (QUuid string), survives edits
    QString name;            // display name (file name / title text)
    QString mediaPath;       // empty for title clips
    QString text;            // title text (Title kind only)
    ClipKind kind = ClipKind::Video;
    QString role = RoleNames::kDialogue;

    double sourceIn = 0.0;   // seconds into the source media
    double sourceOut = 0.0;  // seconds into the source media
    // Primary clips: absolute timeline start. Connected clips: cached
    // absolute start, recomputed from the anchor whenever the primary
    // storyline changes (see TimelineModel::recomputeConnected).
    double timelineStart = 0.0;
    bool enabled = true;

    // --- connected-clip anchoring (ignored for primary clips) ---
    bool connected = false;
    QString anchorClipId;        // primary clip this anchors to
    double anchorOffsetInClip = 0.0; // anchor point = anchor.timelineStart + this
    double anchorDelta = 0.0;    // clip start - anchor point (may be < 0)
    QString storylineId;         // secondary storyline this belongs to ("" = none)
    bool detached = false;       // was connected, disconnected via the escape hatch

    KeyframeSet keyframes;
    double volume = 1.0; // audio gain, 0..1+ (S4 honours it)

    // --- S3 colour / picture effects (per clip) ---
    // Grade is evaluated into FrameLayer by TimelineEvaluator and
    // applied by TimelineFrameRenderer (the one shared preview/export
    // path). gradeEnabled=false means "no grade on this clip".
    ColorGrade grade;
    bool gradeEnabled = false;
    BeautySettings beauty;
    ChromaKey chromaKey; // green-screen key; portrait-background
                         // keying lives here too (see S3 doc: beauty and
                         // portrait keying are mutually exclusive)
    MaskShape mask;      // shape mask (rectangle / circle / pen polygon)
    bool maskEnabled = false;

    double duration() const { return sourceOut - sourceIn; }
    double timelineEnd() const { return timelineStart + duration(); }

    QJsonObject toJson() const;
    static Clip fromJson(const QJsonObject& object, bool& ok);
};

struct TimelineLane {
    QString label;   // e.g. "主故事线", "音乐", "音效"
    QString role;    // role name ("" for the primary lane)
    bool isAudio = false;
    bool isPrimary = false;
};

class TimelineModel {
public:
    TimelineModel();

    // --- primary storyline (ripple) ---
    const QList<Clip>& primaryClips() const { return m_primary; }
    const QList<Clip>& connectedClips() const { return m_connected; }
    double totalDuration() const;
    bool isEmpty() const { return m_primary.isEmpty() && m_connected.isEmpty(); }

    // Appends a clip at the end of the primary storyline.
    // Returns false when the clip has no positive duration.
    bool appendPrimaryClip(const Clip& clip);
    // Inserts at `time` (clamped to [0, totalDuration]); clips at or
    // after the insertion point ripple right. Inserting inside a clip
    // splits it first. Returns the inserted clip's id, or "" on failure.
    QString insertPrimaryClip(const Clip& clip, double time);
    // Ripple delete: later primary clips close up. Connected clips
    // anchored to the deleted clip become detached (frozen in place);
    // connected clips anchored later shift with the ripple.
    bool removePrimaryClip(const QString& clipId);
    // Plain removal of a connected clip (it was never part of the
    // primary storyline, so nothing ripples).
    bool removeConnectedClip(const QString& clipId);
    // Ripple move: remove + re-insert at `newStart`.
    bool movePrimaryClip(const QString& clipId, double newStart);
    // Splits the primary clip covering `time` into two clips at `time`.
    // Returns the new (right-hand) clip's id, or "" when no clip covers
    // the time or the split would leave a < 0.1s side.
    QString splitPrimaryAt(double time);
    QString splitClipAt(const QString& clipId, double time);
    // Ripple trim: change one end and shift everything after it.
    // Returns false (no change) when the trim would make the clip
    // shorter than kMinClipDuration or move its start before 0.
    bool rippleTrimStart(const QString& clipId, double deltaSeconds);
    bool rippleTrimEnd(const QString& clipId, double deltaSeconds);
    // Roll trim: move the boundary between primary clips `leftIndex`
    // and `leftIndex + 1`; the left clip grows/shrinks, the right clip
    // does the opposite, total duration unchanged.
    bool rollTrim(int leftIndex, double deltaSeconds);

    // --- connected clips ---
    // Adds a connected clip anchored to `anchorClipId` at
    // `anchorOffsetInClip` seconds into the anchor, starting
    // `anchorDelta` seconds from that anchor point.
    QString addConnectedClip(const Clip& clip, const QString& anchorClipId,
                             double anchorOffsetInClip, double anchorDelta);
    // Disconnect escape hatch: the clip keeps its current absolute
    // position and stops following the primary storyline.
    bool disconnectClip(const QString& clipId);
    // Re-anchors a detached (or any connected) clip.
    bool reconnectClip(const QString& clipId, const QString& anchorClipId,
                       double anchorOffsetInClip, double anchorDelta);
    // Moves a connected clip by `deltaSeconds` (adjusts anchorDelta;
    // a detached clip moves its absolute start instead).
    bool moveConnectedClip(const QString& clipId, double deltaSeconds);

    // --- secondary storylines ---
    QString createStoryline(const QString& name, const QList<QString>& clipIds);
    bool moveStoryline(const QString& storylineId, double deltaSeconds);
    bool renameStoryline(const QString& storylineId, const QString& name);
    QList<Clip> storylineClips(const QString& storylineId) const;
    QMap<QString, QString> storylines() const { return m_storylineNames; }

    // --- transitions (one per primary boundary, keyed by left clip) ---
    bool setTransition(const QString& leftClipId, const Transition& transition);
    bool removeTransition(const QString& leftClipId);
    const Transition* transitionAfter(const QString& leftClipId) const;
    // Transition whose centred window [cut - d/2, cut + d/2] contains t.
    // Returns false when t is not inside any transition window.
    bool transitionAt(double time, Transition& out, double& progressOut,
                      QString& leftClipIdOut, QString& rightClipIdOut) const;

    // --- lookup ---
    Clip* findClip(const QString& clipId);
    const Clip* findClip(const QString& clipId) const;
    int primaryIndexOf(const QString& clipId) const;
    // Primary clip covering `time` (normal range, ignoring transition
    // overlap). nullptr when t is past the end / before 0.
    const Clip* primaryClipAt(double time) const;

    // --- roles / lanes / stems ---
    RoleRegistry& roleRegistry() { return m_roles; }
    const RoleRegistry& roleRegistry() const { return m_roles; }
    // Lanes in display order: primary, connected video lanes per role,
    // audio lanes per role. Clip -> lane index via laneIndexOf().
    QList<TimelineLane> computeLanes() const;
    int laneIndexOf(const QString& clipId) const;
    // Per-role stem export hook for S4: role -> clip ids (audio clips
    // and video clips, title clips excluded).
    QMap<QString, QList<QString>> stemsByRole() const;

    // --- misc ---
    // Recomputes every connected clip's cached timelineStart from its
    // anchor. Called automatically after every primary mutation.
    void recomputeConnected();
    static constexpr double kMinClipDuration = 0.1;

    // --- S3 project-level picture state (canvas / motion / pointer) ---
    const CanvasStyle& canvasStyle() const { return m_canvas; }
    void setCanvasStyle(const CanvasStyle& style) { m_canvas = style; }

    const QList<MosaicClip>& mosaics() const { return m_mosaics; }
    void addMosaic(const MosaicClip& clip) { m_mosaics.append(clip); }
    bool removeMosaic(const QString& clipId);
    MosaicClip* findMosaic(const QString& clipId);

    const QList<ClickEvent>& clickEvents() const { return m_clicks; }
    void setClickEvents(const QList<ClickEvent>& clicks) { m_clicks = clicks; }
    void addClickEvent(const ClickEvent& click) { m_clicks.append(click); }

    const QList<AutoZoomSegment>& manualZoomSegments() const { return m_manualZoom; }
    void setManualZoomSegments(const QList<AutoZoomSegment>& segments) { m_manualZoom = segments; }
    bool autoZoomEnabled() const { return m_autoZoomEnabled; }
    void setAutoZoomEnabled(bool enabled) { m_autoZoomEnabled = enabled; }
    // Planned auto-zoom segments (auto groups + manual, sorted).
    QList<AutoZoomSegment> plannedAutoZoom() const;
    double autoZoomAt(double t, QPointF& focusOut) const;

    const QList<ScreenMotionSegment>& screenMotions() const { return m_screenMotions; }
    void addScreenMotion(const ScreenMotionSegment& segment) { m_screenMotions.append(segment); }
    bool removeScreenMotion(const QString& segmentId);
    // Interpolated 3D pose at `t` (identity + active=false outside).
    Screen3D screen3DPoseAt(double t, bool& activeOut) const;

    const PointerTrack& pointerTrack() const { return m_pointer; }
    void setPointerTrack(const PointerTrack& track) { m_pointer = track; }

    const FocusEffect& zoomFocus() const { return m_zoomFocus; }
    void setZoomFocus(const FocusEffect& focus) { m_zoomFocus = focus; }
    const FocusEffect& screen3DFocus() const { return m_screen3DFocus; }
    void setScreen3DFocus(const FocusEffect& focus) { m_screen3DFocus = focus; }
    const SpringParams& screenSpring() const { return m_screenSpring; }
    void setScreenSpring(const SpringParams& spring) { m_screenSpring = spring; }
    const SpringParams& cursorSpring() const { return m_cursorSpring; }
    void setCursorSpring(const SpringParams& spring) { m_cursorSpring = spring; }

    QJsonObject toJson() const;
    bool fromJson(const QJsonObject& object, QString& error);

private:
    void shiftPrimaryFrom(int index, double deltaSeconds);
    void reanchorOrDetachAfterPrimaryRemoval(const QString& removedClipId,
                                             double removedStart, double removedDuration);
    int roleOrder(const QString& role) const;

    QList<Clip> m_primary;
    QList<Clip> m_connected;
    QMap<QString, Transition> m_transitions; // key: left (primary) clip id
    QMap<QString, QString> m_storylineNames; // storyline id -> name
    RoleRegistry m_roles;

    // --- S3 project-level picture state ---
    CanvasStyle m_canvas;
    QList<MosaicClip> m_mosaics;
    QList<ClickEvent> m_clicks;
    QList<AutoZoomSegment> m_manualZoom;
    bool m_autoZoomEnabled = true;
    QList<ScreenMotionSegment> m_screenMotions;
    PointerTrack m_pointer;
    FocusEffect m_zoomFocus;
    FocusEffect m_screen3DFocus;
    SpringParams m_screenSpring;
    SpringParams m_cursorSpring;
};

} // namespace catcut
