#include "core/TimelineModel.h"

#include <QJsonArray>
#include <QUuid>
#include <algorithm>
#include <cmath>

namespace catcut {

namespace {

QString newClipId()
{
    return QUuid::createUuid().toString(QUuid::WithoutBraces);
}

QJsonObject keyframeToJson(const Keyframe& k)
{
    QJsonObject o;
    o.insert(QStringLiteral("t"), k.time);
    o.insert(QStringLiteral("v"), k.value);
    o.insert(QStringLiteral("outDx"), k.outDx);
    o.insert(QStringLiteral("outDy"), k.outDy);
    o.insert(QStringLiteral("inDx"), k.inDx);
    o.insert(QStringLiteral("inDy"), k.inDy);
    o.insert(QStringLiteral("interp"), static_cast<int>(k.interpolation));
    return o;
}

Keyframe keyframeFromJson(const QJsonObject& o, bool& ok)
{
    Keyframe k;
    ok = o.contains(QStringLiteral("t")) && o.contains(QStringLiteral("v"));
    if (!ok)
        return k;
    k.time = o.value(QStringLiteral("t")).toDouble();
    k.value = o.value(QStringLiteral("v")).toDouble();
    k.outDx = o.value(QStringLiteral("outDx")).toDouble();
    k.outDy = o.value(QStringLiteral("outDy")).toDouble();
    k.inDx = o.value(QStringLiteral("inDx")).toDouble();
    k.inDy = o.value(QStringLiteral("inDy")).toDouble();
    const int interp = o.value(QStringLiteral("interp")).toInt(0);
    k.interpolation = interp == 1 ? KeyframeInterpolation::Bezier
        : interp == 2 ? KeyframeInterpolation::Hold : KeyframeInterpolation::Linear;
    return k;
}

QJsonArray trackToJson(const KeyframeTrack& track)
{
    QJsonArray a;
    for (const Keyframe& k : track.keyframes())
        a.append(keyframeToJson(k));
    return a;
}

KeyframeTrack trackFromJson(const QJsonValue& value, double defaultValue)
{
    KeyframeTrack track(defaultValue);
    if (!value.isArray())
        return track;
    for (const QJsonValue& v : value.toArray()) {
        if (!v.isObject())
            continue;
        bool ok = false;
        const Keyframe k = keyframeFromJson(v.toObject(), ok);
        if (ok)
            track.addKeyframe(k);
    }
    return track;
}

QJsonObject keyframeSetToJson(const KeyframeSet& set)
{
    QJsonObject o;
    o.insert(QStringLiteral("x"), trackToJson(set.positionX));
    o.insert(QStringLiteral("y"), trackToJson(set.positionY));
    o.insert(QStringLiteral("scale"), trackToJson(set.scale));
    o.insert(QStringLiteral("rotation"), trackToJson(set.rotation));
    o.insert(QStringLiteral("opacity"), trackToJson(set.opacity));
    QJsonObject effects;
    for (auto it = set.effects.begin(); it != set.effects.end(); ++it)
        effects.insert(it.key(), trackToJson(it.value()));
    if (!effects.isEmpty())
        o.insert(QStringLiteral("effects"), effects);
    return o;
}

KeyframeSet keyframeSetFromJson(const QJsonObject& o)
{
    KeyframeSet set;
    set.positionX = trackFromJson(o.value(QStringLiteral("x")), 0.5);
    set.positionY = trackFromJson(o.value(QStringLiteral("y")), 0.5);
    set.scale = trackFromJson(o.value(QStringLiteral("scale")), 1.0);
    set.rotation = trackFromJson(o.value(QStringLiteral("rotation")), 0.0);
    set.opacity = trackFromJson(o.value(QStringLiteral("opacity")), 1.0);
    const QJsonObject effects = o.value(QStringLiteral("effects")).toObject();
    for (auto it = effects.begin(); it != effects.end(); ++it)
        set.effects.insert(it.key(), trackFromJson(it.value(), 0.0));
    return set;
}

} // namespace

QString clipKindName(ClipKind kind)
{
    switch (kind) {
    case ClipKind::Video: return QStringLiteral("video");
    case ClipKind::Audio: return QStringLiteral("audio");
    case ClipKind::Title: return QStringLiteral("title");
    }
    return QStringLiteral("video");
}

ClipKind clipKindFromName(const QString& name, ClipKind fallback)
{
    if (name == QStringLiteral("audio"))
        return ClipKind::Audio;
    if (name == QStringLiteral("title"))
        return ClipKind::Title;
    if (name == QStringLiteral("video"))
        return ClipKind::Video;
    return fallback;
}

QJsonObject Clip::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("mediaPath"), mediaPath);
    o.insert(QStringLiteral("text"), text);
    o.insert(QStringLiteral("kind"), clipKindName(kind));
    o.insert(QStringLiteral("role"), role);
    o.insert(QStringLiteral("sourceIn"), sourceIn);
    o.insert(QStringLiteral("sourceOut"), sourceOut);
    o.insert(QStringLiteral("timelineStart"), timelineStart);
    o.insert(QStringLiteral("enabled"), enabled);
    o.insert(QStringLiteral("connected"), connected);
    o.insert(QStringLiteral("anchorClipId"), anchorClipId);
    o.insert(QStringLiteral("anchorOffsetInClip"), anchorOffsetInClip);
    o.insert(QStringLiteral("anchorDelta"), anchorDelta);
    o.insert(QStringLiteral("storylineId"), storylineId);
    o.insert(QStringLiteral("detached"), detached);
    o.insert(QStringLiteral("volume"), volume);
    o.insert(QStringLiteral("keyframes"), keyframeSetToJson(keyframes));
    return o;
}

Clip Clip::fromJson(const QJsonObject& o, bool& ok)
{
    Clip c;
    ok = o.contains(QStringLiteral("id")) && o.contains(QStringLiteral("sourceIn"))
        && o.contains(QStringLiteral("sourceOut"));
    if (!ok)
        return c;
    c.id = o.value(QStringLiteral("id")).toString();
    c.name = o.value(QStringLiteral("name")).toString();
    c.mediaPath = o.value(QStringLiteral("mediaPath")).toString();
    c.text = o.value(QStringLiteral("text")).toString();
    c.kind = clipKindFromName(o.value(QStringLiteral("kind")).toString(), ClipKind::Video);
    c.role = o.value(QStringLiteral("role")).toString(RoleNames::kDialogue);
    c.sourceIn = o.value(QStringLiteral("sourceIn")).toDouble();
    c.sourceOut = o.value(QStringLiteral("sourceOut")).toDouble();
    c.timelineStart = o.value(QStringLiteral("timelineStart")).toDouble();
    c.enabled = o.value(QStringLiteral("enabled")).toBool(true);
    c.connected = o.value(QStringLiteral("connected")).toBool(false);
    c.anchorClipId = o.value(QStringLiteral("anchorClipId")).toString();
    c.anchorOffsetInClip = o.value(QStringLiteral("anchorOffsetInClip")).toDouble();
    c.anchorDelta = o.value(QStringLiteral("anchorDelta")).toDouble();
    c.storylineId = o.value(QStringLiteral("storylineId")).toString();
    c.detached = o.value(QStringLiteral("detached")).toBool(false);
    c.volume = o.value(QStringLiteral("volume")).toDouble(1.0);
    c.keyframes = keyframeSetFromJson(o.value(QStringLiteral("keyframes")).toObject());
    ok = c.duration() > 0.0 && !c.id.isEmpty();
    return c;
}

// ------------------------------------------------------------------ model

TimelineModel::TimelineModel() = default;

double TimelineModel::totalDuration() const
{
    double total = 0.0;
    for (const Clip& c : m_primary)
        total = std::max(total, c.timelineEnd());
    return total;
}

int TimelineModel::roleOrder(const QString& role) const
{
    const int idx = m_roles.indexOf(role);
    return idx >= 0 ? idx : m_roles.roles().size();
}

bool TimelineModel::appendPrimaryClip(const Clip& clip)
{
    if (clip.duration() <= 0.0)
        return false;
    Clip c = clip;
    if (c.id.isEmpty())
        c.id = newClipId();
    if (c.role.isEmpty())
        c.role = defaultRoleForKind(clipKindName(c.kind));
    m_roles.addCustomRole(c.role);
    c.connected = false;
    c.detached = false;
    c.storylineId.clear();
    c.timelineStart = totalDuration();
    m_primary.append(c);
    return true;
}

QString TimelineModel::insertPrimaryClip(const Clip& clip, double time)
{
    if (clip.duration() <= 0.0)
        return QString();
    const double total = totalDuration();
    double at = std::clamp(time, 0.0, total);
    // Inserting inside a clip splits it first, so the new clip lands
    // exactly on a boundary.
    const Clip* covering = primaryClipAt(at);
    if (covering && at > covering->timelineStart + 1e-9
        && at < covering->timelineEnd() - 1e-9) {
        if (splitClipAt(covering->id, at).isEmpty())
            return QString();
    }
    Clip c = clip;
    if (c.id.isEmpty())
        c.id = newClipId();
    if (c.role.isEmpty())
        c.role = defaultRoleForKind(clipKindName(c.kind));
    m_roles.addCustomRole(c.role);
    c.connected = false;
    c.detached = false;
    c.storylineId.clear();
    c.timelineStart = at;
    int index = 0;
    while (index < m_primary.size() && m_primary[index].timelineStart < at - 1e-9)
        ++index;
    shiftPrimaryFrom(index, c.duration());
    m_primary.insert(index, c);
    recomputeConnected();
    return c.id;
}

void TimelineModel::shiftPrimaryFrom(int index, double deltaSeconds)
{
    if (std::fabs(deltaSeconds) < 1e-12)
        return;
    for (int i = index; i < m_primary.size(); ++i)
        m_primary[i].timelineStart += deltaSeconds;
}

bool TimelineModel::removePrimaryClip(const QString& clipId)
{
    const int index = primaryIndexOf(clipId);
    if (index < 0)
        return false;
    const Clip removed = m_primary[index];
    m_primary.removeAt(index);
    m_transitions.remove(clipId);
    // The boundary *before* the removed clip belonged to the previous
    // clip; it stays valid. The transition keyed by the removed clip
    // (boundary after it) is gone with the clip.
    shiftPrimaryFrom(index, -removed.duration());
    reanchorOrDetachAfterPrimaryRemoval(clipId, removed.timelineStart, removed.duration());
    recomputeConnected();
    return true;
}

bool TimelineModel::removeConnectedClip(const QString& clipId)
{
    for (int i = 0; i < m_connected.size(); ++i) {
        if (m_connected[i].id == clipId) {
            m_connected.removeAt(i);
            return true;
        }
    }
    return false;
}

void TimelineModel::reanchorOrDetachAfterPrimaryRemoval(const QString& removedClipId,
                                                        double /*removedStart*/,
                                                        double /*removedDuration*/)
{
    // Connected clips anchored to the deleted clip lose their anchor:
    // they detach and freeze at their current absolute position (the
    // disconnect escape hatch, applied automatically instead of
    // deleting the user's B-roll with its anchor).
    for (Clip& c : m_connected) {
        if (c.connected && c.anchorClipId == removedClipId) {
            c.connected = false;
            c.detached = true;
            c.anchorClipId.clear();
        }
    }
}

bool TimelineModel::movePrimaryClip(const QString& clipId, double newStart)
{
    const int index = primaryIndexOf(clipId);
    if (index < 0)
        return false;
    Clip clip = m_primary[index];
    const double total = totalDuration();
    const double at = std::clamp(newStart, 0.0, std::max(0.0, total - clip.duration()));
    if (std::fabs(at - clip.timelineStart) < 1e-9)
        return true;
    // Remove (ripple close) then insert at the new spot. Connected
    // clips keep their anchor (same clip id) and follow through
    // recomputeConnected() in insertPrimaryClip — a move must NOT
    // detach them (only a real removal does that). The outgoing
    // transition travels with the clip.
    const bool hadTransition = m_transitions.contains(clipId);
    const Transition savedTransition = hadTransition ? m_transitions.value(clipId) : Transition();
    m_primary.removeAt(index);
    m_transitions.remove(clipId);
    shiftPrimaryFrom(index, -clip.duration());
    clip.timelineStart = at;
    const QString id = insertPrimaryClip(clip, at);
    if (id.isEmpty())
        return false;
    if (hadTransition)
        setTransition(id, savedTransition);
    return true;
}

QString TimelineModel::splitClipAt(const QString& clipId, double time)
{
    const int index = primaryIndexOf(clipId);
    if (index < 0)
        return QString();
    Clip& left = m_primary[index];
    const double offset = time - left.timelineStart;
    if (offset < kMinClipDuration || left.duration() - offset < kMinClipDuration)
        return QString();
    Clip right = left;
    right.id = newClipId();
    right.sourceIn = left.sourceIn + offset;
    right.timelineStart = time;
    left.sourceOut = left.sourceIn + offset;
    // Keyframes after the split point move to the right clip, retimed.
    // (Tracks are per-clip; times are clip-relative.)
    KeyframeSet rightKeys;
    auto splitTrack = [](KeyframeTrack& src, KeyframeTrack& dst, double offset) {
        QList<Keyframe> keep;
        for (const Keyframe& k : src.keyframes()) {
            if (k.time <= offset) {
                keep.append(k);
            } else {
                Keyframe moved = k;
                moved.time -= offset;
                dst.addKeyframe(moved);
            }
        }
        src.clear();
        for (const Keyframe& k : keep)
            src.addKeyframe(k);
    };
    splitTrack(left.keyframes.positionX, rightKeys.positionX, offset);
    splitTrack(left.keyframes.positionY, rightKeys.positionY, offset);
    splitTrack(left.keyframes.scale, rightKeys.scale, offset);
    splitTrack(left.keyframes.rotation, rightKeys.rotation, offset);
    splitTrack(left.keyframes.opacity, rightKeys.opacity, offset);
    for (auto it = left.keyframes.effects.begin(); it != left.keyframes.effects.end(); ++it) {
        KeyframeTrack dst(it.value().defaultValue());
        splitTrack(it.value(), dst, offset);
        if (!dst.isEmpty())
            rightKeys.effects.insert(it.key(), dst);
    }
    right.keyframes = rightKeys;
    // A transition after the left clip now belongs after the right one.
    if (m_transitions.contains(clipId)) {
        m_transitions.insert(right.id, m_transitions.take(clipId));
    }
    m_primary.insert(index + 1, right);
    recomputeConnected();
    return right.id;
}

QString TimelineModel::splitPrimaryAt(double time)
{
    const Clip* covering = primaryClipAt(time);
    if (!covering)
        return QString();
    return splitClipAt(covering->id, time);
}

bool TimelineModel::rippleTrimStart(const QString& clipId, double deltaSeconds)
{
    const int index = primaryIndexOf(clipId);
    if (index < 0)
        return false;
    Clip& clip = m_primary[index];
    // delta > 0: start moves later (clip shortens, later clips close up).
    // delta < 0: start moves earlier (clip grows into source handle).
    const double newDuration = clip.duration() - deltaSeconds;
    if (newDuration < kMinClipDuration)
        return false;
    if (clip.timelineStart + deltaSeconds < 0.0)
        return false;
    if (clip.sourceIn + deltaSeconds < 0.0)
        return false; // no source handle before the in-point
    clip.sourceIn += deltaSeconds;
    clip.timelineStart += deltaSeconds;
    shiftPrimaryFrom(index + 1, -deltaSeconds);
    recomputeConnected();
    return true;
}

bool TimelineModel::rippleTrimEnd(const QString& clipId, double deltaSeconds)
{
    const int index = primaryIndexOf(clipId);
    if (index < 0)
        return false;
    Clip& clip = m_primary[index];
    const double newDuration = clip.duration() + deltaSeconds;
    if (newDuration < kMinClipDuration)
        return false;
    clip.sourceOut += deltaSeconds;
    shiftPrimaryFrom(index + 1, deltaSeconds);
    recomputeConnected();
    return true;
}

bool TimelineModel::rollTrim(int leftIndex, double deltaSeconds)
{
    if (leftIndex < 0 || leftIndex + 1 >= m_primary.size())
        return false;
    Clip& left = m_primary[leftIndex];
    Clip& right = m_primary[leftIndex + 1];
    // delta > 0: boundary moves later — left grows, right shrinks.
    const double newLeft = left.duration() + deltaSeconds;
    const double newRight = right.duration() - deltaSeconds;
    if (newLeft < kMinClipDuration || newRight < kMinClipDuration)
        return false;
    if (right.sourceIn + deltaSeconds < 0.0)
        return false; // right clip has no source handle before its in-point
    left.sourceOut += deltaSeconds;
    right.sourceIn += deltaSeconds;
    right.timelineStart += deltaSeconds;
    recomputeConnected();
    return true;
}

// ------------------------------------------------------- connected clips

QString TimelineModel::addConnectedClip(const Clip& clip, const QString& anchorClipId,
                                        double anchorOffsetInClip, double anchorDelta)
{
    if (clip.duration() <= 0.0)
        return QString();
    if (primaryIndexOf(anchorClipId) < 0)
        return QString();
    Clip c = clip;
    if (c.id.isEmpty())
        c.id = newClipId();
    if (c.role.isEmpty())
        c.role = defaultRoleForKind(clipKindName(c.kind));
    m_roles.addCustomRole(c.role);
    c.connected = true;
    c.detached = false;
    c.anchorClipId = anchorClipId;
    c.anchorOffsetInClip = anchorOffsetInClip;
    c.anchorDelta = anchorDelta;
    m_connected.append(c);
    recomputeConnected();
    return c.id;
}

bool TimelineModel::disconnectClip(const QString& clipId)
{
    Clip* clip = findClip(clipId);
    if (!clip || !clip->connected)
        return false;
    // Freeze at the current absolute position — that is the whole point
    // of the escape hatch: the clip stays exactly where it is on screen.
    clip->connected = false;
    clip->detached = true;
    clip->anchorClipId.clear();
    clip->storylineId.clear();
    return true;
}

bool TimelineModel::reconnectClip(const QString& clipId, const QString& anchorClipId,
                                  double anchorOffsetInClip, double anchorDelta)
{
    Clip* clip = findClip(clipId);
    if (!clip || primaryIndexOf(anchorClipId) < 0)
        return false;
    clip->connected = true;
    clip->detached = false;
    clip->anchorClipId = anchorClipId;
    clip->anchorOffsetInClip = anchorOffsetInClip;
    clip->anchorDelta = anchorDelta;
    recomputeConnected();
    return true;
}

bool TimelineModel::moveConnectedClip(const QString& clipId, double deltaSeconds)
{
    Clip* clip = findClip(clipId);
    if (!clip)
        return false;
    if (clip->connected) {
        clip->anchorDelta += deltaSeconds;
        recomputeConnected();
    } else {
        clip->timelineStart = std::max(0.0, clip->timelineStart + deltaSeconds);
    }
    return true;
}

void TimelineModel::recomputeConnected()
{
    for (Clip& c : m_connected) {
        if (!c.connected)
            continue;
        const Clip* anchor = findClip(c.anchorClipId);
        if (!anchor) { // anchor vanished without removal bookkeeping
            c.connected = false;
            c.detached = true;
            c.anchorClipId.clear();
            continue;
        }
        const double anchorPoint = anchor->timelineStart + c.anchorOffsetInClip;
        c.timelineStart = std::max(0.0, anchorPoint + c.anchorDelta);
    }
}

// ------------------------------------------------- secondary storylines

QString TimelineModel::createStoryline(const QString& name, const QList<QString>& clipIds)
{
    if (clipIds.isEmpty())
        return QString();
    const QString id = newClipId();
    m_storylineNames.insert(id, name.isEmpty() ? QStringLiteral("次要故事情节") : name);
    int assigned = 0;
    for (const QString& clipId : clipIds) {
        Clip* clip = findClip(clipId);
        if (clip && clip->connected) {
            clip->storylineId = id;
            ++assigned;
        }
    }
    if (assigned == 0) {
        m_storylineNames.remove(id);
        return QString();
    }
    return id;
}

bool TimelineModel::moveStoryline(const QString& storylineId, double deltaSeconds)
{
    if (!m_storylineNames.contains(storylineId))
        return false;
    bool moved = false;
    for (Clip& c : m_connected) {
        if (c.storylineId == storylineId && c.connected) {
            c.anchorDelta += deltaSeconds;
            moved = true;
        }
    }
    if (moved)
        recomputeConnected();
    return moved;
}

bool TimelineModel::renameStoryline(const QString& storylineId, const QString& name)
{
    if (!m_storylineNames.contains(storylineId) || name.trimmed().isEmpty())
        return false;
    m_storylineNames[storylineId] = name;
    return true;
}

QList<Clip> TimelineModel::storylineClips(const QString& storylineId) const
{
    QList<Clip> out;
    for (const Clip& c : m_connected) {
        if (c.storylineId == storylineId)
            out.append(c);
    }
    return out;
}

// ------------------------------------------------------------ transitions

bool TimelineModel::setTransition(const QString& leftClipId, const Transition& transition)
{
    const int index = primaryIndexOf(leftClipId);
    if (index < 0 || index + 1 >= m_primary.size())
        return false; // no clip after the boundary — nothing to transition to
    if (!transition.isValid())
        return false;
    m_transitions.insert(leftClipId, transition);
    return true;
}

bool TimelineModel::removeTransition(const QString& leftClipId)
{
    return m_transitions.remove(leftClipId) > 0;
}

const Transition* TimelineModel::transitionAfter(const QString& leftClipId) const
{
    auto it = m_transitions.find(leftClipId);
    return it == m_transitions.end() ? nullptr : &it.value();
}

bool TimelineModel::transitionAt(double time, Transition& out, double& progressOut,
                                 QString& leftClipIdOut, QString& rightClipIdOut) const
{
    for (int i = 0; i + 1 < m_primary.size(); ++i) {
        const Transition* t = transitionAfter(m_primary[i].id);
        if (!t)
            continue;
        const double cut = m_primary[i].timelineEnd();
        const double half = t->duration / 2.0;
        if (time >= cut - half - 1e-9 && time <= cut + half + 1e-9) {
            out = *t;
            progressOut = std::clamp((time - (cut - half)) / t->duration, 0.0, 1.0);
            leftClipIdOut = m_primary[i].id;
            rightClipIdOut = m_primary[i + 1].id;
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------- lookup

Clip* TimelineModel::findClip(const QString& clipId)
{
    for (Clip& c : m_primary) {
        if (c.id == clipId)
            return &c;
    }
    for (Clip& c : m_connected) {
        if (c.id == clipId)
            return &c;
    }
    return nullptr;
}

const Clip* TimelineModel::findClip(const QString& clipId) const
{
    for (const Clip& c : m_primary) {
        if (c.id == clipId)
            return &c;
    }
    for (const Clip& c : m_connected) {
        if (c.id == clipId)
            return &c;
    }
    return nullptr;
}

int TimelineModel::primaryIndexOf(const QString& clipId) const
{
    for (int i = 0; i < m_primary.size(); ++i) {
        if (m_primary[i].id == clipId)
            return i;
    }
    return -1;
}

const Clip* TimelineModel::primaryClipAt(double time) const
{
    if (time < 0.0)
        return nullptr;
    for (const Clip& c : m_primary) {
        if (time >= c.timelineStart - 1e-9 && time < c.timelineEnd() - 1e-9)
            return &c;
    }
    return nullptr;
}

// ------------------------------------------------------- roles / lanes

QList<TimelineLane> TimelineModel::computeLanes() const
{
    QList<TimelineLane> lanes;
    TimelineLane primary;
    primary.label = QStringLiteral("主故事线");
    primary.isPrimary = true;
    lanes.append(primary);

    // Connected video/title lanes, one per role in use, registry order.
    QList<QString> videoRoles;
    QList<QString> audioRoles;
    for (const Clip& c : m_connected) {
        if (c.kind == ClipKind::Audio) {
            if (!audioRoles.contains(c.role))
                audioRoles.append(c.role);
        } else if (!videoRoles.contains(c.role)) {
            videoRoles.append(c.role);
        }
    }
    std::sort(videoRoles.begin(), videoRoles.end(),
              [this](const QString& a, const QString& b) { return roleOrder(a) < roleOrder(b); });
    std::sort(audioRoles.begin(), audioRoles.end(),
              [this](const QString& a, const QString& b) { return roleOrder(a) < roleOrder(b); });
    for (const QString& role : videoRoles) {
        TimelineLane lane;
        lane.label = role;
        lane.role = role;
        lanes.append(lane);
    }
    for (const QString& role : audioRoles) {
        TimelineLane lane;
        lane.label = role;
        lane.role = role;
        lane.isAudio = true;
        lanes.append(lane);
    }
    return lanes;
}

int TimelineModel::laneIndexOf(const QString& clipId) const
{
    const Clip* clip = findClip(clipId);
    if (!clip)
        return -1;
    if (primaryIndexOf(clipId) >= 0)
        return 0;
    const QList<TimelineLane> lanes = computeLanes();
    for (int i = 1; i < lanes.size(); ++i) {
        if (lanes[i].role == clip->role
            && lanes[i].isAudio == (clip->kind == ClipKind::Audio))
            return i;
    }
    return -1;
}

QMap<QString, QList<QString>> TimelineModel::stemsByRole() const
{
    QMap<QString, QList<QString>> stems;
    auto addClip = [&stems](const Clip& c) {
        if (c.kind == ClipKind::Title)
            return; // titles have no audio stem
        stems[c.role].append(c.id);
    };
    for (const Clip& c : m_primary)
        addClip(c);
    for (const Clip& c : m_connected)
        addClip(c);
    return stems;
}

// ------------------------------------------------------------------ JSON

QJsonObject TimelineModel::toJson() const
{
    QJsonObject root;
    QJsonArray primary;
    for (const Clip& c : m_primary)
        primary.append(c.toJson());
    root.insert(QStringLiteral("primary"), primary);
    QJsonArray connected;
    for (const Clip& c : m_connected)
        connected.append(c.toJson());
    root.insert(QStringLiteral("connected"), connected);
    QJsonObject transitions;
    for (auto it = m_transitions.begin(); it != m_transitions.end(); ++it) {
        QJsonObject t;
        t.insert(QStringLiteral("type"), static_cast<int>(it.value().type));
        t.insert(QStringLiteral("duration"), it.value().duration);
        transitions.insert(it.key(), t);
    }
    root.insert(QStringLiteral("transitions"), transitions);
    QJsonObject storylines;
    for (auto it = m_storylineNames.begin(); it != m_storylineNames.end(); ++it)
        storylines.insert(it.key(), it.value());
    root.insert(QStringLiteral("storylines"), storylines);
    QJsonArray customRoles;
    for (const QString& role : m_roles.roles()) {
        if (!m_roles.isBuiltIn(role))
            customRoles.append(role);
    }
    root.insert(QStringLiteral("customRoles"), customRoles);
    return root;
}

bool TimelineModel::fromJson(const QJsonObject& object, QString& error)
{
    TimelineModel fresh;
    const QJsonArray customRoles = object.value(QStringLiteral("customRoles")).toArray();
    for (const QJsonValue& v : customRoles)
        fresh.m_roles.addCustomRole(v.toString());

    const QJsonArray primary = object.value(QStringLiteral("primary")).toArray();
    for (const QJsonValue& v : primary) {
        if (!v.isObject()) {
            error = QStringLiteral("时间线数据损坏：主故事线片段不是对象。");
            return false;
        }
        bool ok = false;
        Clip c = Clip::fromJson(v.toObject(), ok);
        if (!ok) {
            error = QStringLiteral("时间线数据损坏：主故事线片段无效。");
            return false;
        }
        c.connected = false;
        c.detached = false;
        c.storylineId.clear();
        fresh.m_roles.addCustomRole(c.role);
        fresh.m_primary.append(c);
    }
    // Primary must stay sorted + contiguous; a file that violates that
    // is repaired by re-laying clips out in stored order.
    double cursor = 0.0;
    for (Clip& c : fresh.m_primary) {
        c.timelineStart = cursor;
        cursor += c.duration();
    }

    const QJsonArray connected = object.value(QStringLiteral("connected")).toArray();
    for (const QJsonValue& v : connected) {
        if (!v.isObject()) {
            error = QStringLiteral("时间线数据损坏：连接片段不是对象。");
            return false;
        }
        bool ok = false;
        Clip c = Clip::fromJson(v.toObject(), ok);
        if (!ok) {
            error = QStringLiteral("时间线数据损坏：连接片段无效。");
            return false;
        }
        fresh.m_roles.addCustomRole(c.role);
        fresh.m_connected.append(c);
    }

    const QJsonObject transitions = object.value(QStringLiteral("transitions")).toObject();
    for (auto it = transitions.begin(); it != transitions.end(); ++it) {
        const QJsonObject t = it.value().toObject();
        Transition tr;
        tr.type = static_cast<TransitionType>(t.value(QStringLiteral("type")).toInt(0));
        tr.setDuration(t.value(QStringLiteral("duration")).toDouble(Transition::kDefaultDuration));
        if (fresh.primaryIndexOf(it.key()) >= 0)
            fresh.m_transitions.insert(it.key(), tr);
    }
    const QJsonObject storylines = object.value(QStringLiteral("storylines")).toObject();
    for (auto it = storylines.begin(); it != storylines.end(); ++it)
        fresh.m_storylineNames.insert(it.key(), it.value().toString());
    fresh.recomputeConnected();

    *this = fresh;
    return true;
}

} // namespace catcut
