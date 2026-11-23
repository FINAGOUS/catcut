#include "ui/TimelineWidget.h"

#include "media/MediaProbe.h"

#include <QApplication>
#include <QContextMenuEvent>
#include <QDrag>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QFileInfo>
#include <QHBoxLayout>
#include <QKeyEvent>
#include <QLabel>
#include <QMimeData>
#include <QMouseEvent>
#include <QPainter>
#include <QPushButton>
#include <QSlider>
#include <QTimer>
#include <QToolButton>
#include <QUrl>

#include <algorithm>
#include <cmath>

namespace catcut {

namespace {

QColor roleColor(const QString& role)
{
    if (role == RoleNames::kMusic)
        return QColor(122, 158, 79);
    if (role == RoleNames::kSfx)
        return QColor(168, 106, 122);
    if (role == RoleNames::kTitle)
        return QColor(138, 127, 214);
    if (role == RoleNames::kDialogue)
        return QColor(201, 138, 43);
    return QColor(176, 137, 60);
}

QString formatTime(double t)
{
    if (t < 0.0)
        t = 0.0;
    const int minutes = static_cast<int>(t) / 60;
    const double seconds = t - minutes * 60.0;
    return QStringLiteral("%1:%2")
        .arg(minutes, 2, 10, QLatin1Char('0'))
        .arg(seconds, 4, 'f', 1, QLatin1Char('0'));
}

} // namespace

TimelineWidget::TimelineWidget(QWidget* parent)
    : QWidget(parent)
{
    setAcceptDrops(true);
    setFocusPolicy(Qt::StrongFocus);
    setMouseTracking(true);
    m_playTimer = new QTimer(this);
    m_playTimer->setInterval(33);
    connect(m_playTimer, &QTimer::timeout, this, [this]() {
        const double total = m_model->totalDuration();
        if (total <= 0.0 || m_playhead >= total - 1e-9) {
            setPlaying(false);
            return;
        }
        setPlayhead(std::min(total, m_playhead + 1.0 / 30.0));
    });
    refreshSize();
}

TimelineWidget::~TimelineWidget() = default;

QSize TimelineWidget::sizeHint() const
{
    return QSize(900, 320);
}

void TimelineWidget::setPlaying(bool playing)
{
    m_playing = playing;
    if (playing)
        m_playTimer->start();
    else
        m_playTimer->stop();
}

void TimelineWidget::setPlayhead(double seconds)
{
    const double clamped = std::clamp(seconds, 0.0, std::max(0.0, m_model->totalDuration()));
    if (std::fabs(clamped - m_playhead) < 1e-9)
        return;
    m_playhead = clamped;
    update();
    emit playheadChanged(m_playhead);
}

void TimelineWidget::setPixelsPerSecond(double px)
{
    m_pxPerSecond = std::clamp(px, 10.0, 400.0);
    refreshSize();
    update();
}

QString TimelineWidget::selectedClipId() const
{
    return m_selectedClipIds.isEmpty() ? QString() : m_selectedClipIds.first();
}

void TimelineWidget::clearSelection()
{
    m_selectedClipIds.clear();
    m_selectedTransitionLeftId.clear();
    update();
    emit selectionChanged();
}

void TimelineWidget::refreshSize()
{
    const QList<TimelineLane> lanes = m_model->computeLanes();
    int height = kRulerHeight + 8;
    for (const TimelineLane& lane : lanes)
        height += laneHeight(lane);
    const int width = kGutterWidth + static_cast<int>(m_model->totalDuration() * m_pxPerSecond) + 400;
    setMinimumSize(width, height);
    resize(width, height);
}

int TimelineWidget::laneHeight(const TimelineLane& lane) const
{
    if (lane.isPrimary)
        return 56;
    return lane.isAudio ? 34 : 46;
}

int TimelineWidget::laneCount() const
{
    return m_model->computeLanes().size();
}

int TimelineWidget::laneTopY(int laneIndex) const
{
    const QList<TimelineLane> lanes = m_model->computeLanes();
    int y = kRulerHeight;
    for (int i = 0; i < laneIndex && i < lanes.size(); ++i)
        y += laneHeight(lanes[i]);
    return y;
}

int TimelineWidget::laneAtY(int y) const
{
    const QList<TimelineLane> lanes = m_model->computeLanes();
    int top = kRulerHeight;
    for (int i = 0; i < lanes.size(); ++i) {
        const int h = laneHeight(lanes[i]);
        if (y >= top && y < top + h)
            return i;
        top += h;
    }
    return -1;
}

double TimelineWidget::timeAtX(int x) const
{
    return std::max(0.0, (x - kGutterWidth) / m_pxPerSecond);
}

int TimelineWidget::xAtTime(double t) const
{
    return kGutterWidth + static_cast<int>(t * m_pxPerSecond);
}

TimelineWidget::HitClip TimelineWidget::hitClipAt(const QPoint& pos) const
{
    HitClip hit;
    const int lane = laneAtY(pos.y());
    if (lane < 0)
        return hit;
    const double t = timeAtX(pos.x());
    auto testClip = [&](const Clip& clip, bool isPrimary) {
        if (t < clip.timelineStart - 1e-9 || t >= clip.timelineEnd() - 1e-9)
            return false;
        hit.clipId = clip.id;
        hit.isPrimary = isPrimary;
        const double edge = kEdgeHit / m_pxPerSecond;
        hit.leftEdge = (t - clip.timelineStart) < edge;
        hit.rightEdge = (clip.timelineEnd() - t) < edge;
        return true;
    };
    if (lane == 0) {
        for (const Clip& clip : m_model->primaryClips()) {
            if (testClip(clip, true))
                return hit;
        }
        return hit;
    }
    for (const Clip& clip : m_model->connectedClips()) {
        if (m_model->laneIndexOf(clip.id) == lane && testClip(clip, false))
            return hit;
    }
    return hit;
}

bool TimelineWidget::boundaryNearX(int x, double& cutTimeOut, QString& leftClipIdOut) const
{
    const QList<Clip>& primary = m_model->primaryClips();
    for (int i = 0; i + 1 < primary.size(); ++i) {
        const int bx = xAtTime(primary[i].timelineEnd());
        if (std::abs(x - bx) <= 8) {
            cutTimeOut = primary[i].timelineEnd();
            leftClipIdOut = primary[i].id;
            return true;
        }
    }
    return false;
}

double TimelineWidget::snapTime(double t) const
{
    const double threshold = 8.0 / m_pxPerSecond;
    double best = t;
    double bestDist = threshold;
    auto consider = [&](double candidate) {
        const double dist = std::fabs(candidate - t);
        if (dist < bestDist) {
            bestDist = dist;
            best = candidate;
        }
    };
    consider(0.0);
    consider(m_playhead);
    for (const Clip& clip : m_model->primaryClips()) {
        consider(clip.timelineStart);
        consider(clip.timelineEnd());
    }
    for (const Clip& clip : m_model->connectedClips()) {
        consider(clip.timelineStart);
        consider(clip.timelineEnd());
    }
    return best;
}

QString TimelineWidget::clipDisplayName(const Clip& clip) const
{
    if (!clip.name.isEmpty())
        return clip.name;
    if (clip.kind == ClipKind::Title)
        return clip.text.isEmpty() ? QStringLiteral("标题") : clip.text;
    return QFileInfo(clip.mediaPath).fileName();
}

// ------------------------------------------------------------------- model ops

QString TimelineWidget::addMediaAt(const QString& path, double time)
{
    const MediaInfo info = MediaProbe::probe(path);
    if (!info.ok) {
        m_lastError = info.error;
        return QString();
    }
    Clip clip;
    clip.mediaPath = path;
    clip.name = QFileInfo(path).fileName();
    const double duration = info.durationSeconds > 0.0 ? info.durationSeconds : 5.0;
    clip.sourceIn = 0.0;
    clip.sourceOut = duration;
    const double at = std::clamp(time, 0.0, m_model->totalDuration());

    const int lane = laneAtY(m_pressPos.y());
    // Dropping on a connected lane anchors the clip to the primary
    // storyline at that moment instead of inserting into it.
    if (lane > 0) {
        clip.kind = info.hasVideo ? ClipKind::Video : ClipKind::Audio;
        clip.role = defaultRoleForKind(clipKindName(clip.kind));
        const Clip* anchor = m_model->primaryClipAt(at);
        if (anchor) {
            const QString id = m_model->addConnectedClip(
                clip, anchor->id, at - anchor->timelineStart, 0.0);
            if (!id.isEmpty()) {
                refreshSize();
                update();
                emit modelChanged();
                return id;
            }
        }
    }
    clip.kind = info.hasVideo ? ClipKind::Video : ClipKind::Audio;
    clip.role = defaultRoleForKind(clipKindName(clip.kind));
    QString id;
    if (at >= m_model->totalDuration() - 1e-9 && m_model->appendPrimaryClip(clip))
        id = m_model->primaryClips().last().id;
    else
        id = m_model->insertPrimaryClip(clip, at);
    if (id.isEmpty())
        m_lastError = QStringLiteral("无法把素材放到时间线（时长无效）。");
    refreshSize();
    update();
    emit modelChanged();
    return id;
}

QString TimelineWidget::addTitleAt(const QString& text, double time, double duration)
{
    Clip clip;
    clip.kind = ClipKind::Title;
    clip.role = RoleNames::kTitle;
    clip.text = text.isEmpty() ? QStringLiteral("标题") : text;
    clip.name = clip.text;
    clip.sourceIn = 0.0;
    clip.sourceOut = std::max(TimelineModel::kMinClipDuration, duration);
    const double at = std::clamp(time, 0.0, m_model->totalDuration());
    const Clip* anchor = m_model->primaryClipAt(at);
    QString id;
    if (anchor)
        id = m_model->addConnectedClip(clip, anchor->id, at - anchor->timelineStart, 0.0);
    else if (m_model->appendPrimaryClip(clip))
        id = m_model->primaryClips().last().id;
    refreshSize();
    update();
    emit modelChanged();
    return id;
}

void TimelineWidget::splitAtPlayhead()
{
    const QString rightId = m_model->splitPrimaryAt(m_playhead);
    if (rightId.isEmpty())
        return;
    m_selectedClipIds = { rightId };
    m_selectedTransitionLeftId.clear();
    refreshSize();
    update();
    emit modelChanged();
    emit selectionChanged();
}

void TimelineWidget::rippleDeleteSelected()
{
    if (m_selectedClipIds.isEmpty())
        return;
    for (const QString& id : m_selectedClipIds) {
        if (m_model->primaryIndexOf(id) >= 0)
            m_model->removePrimaryClip(id);
        else
            m_model->removeConnectedClip(id);
    }
    m_selectedClipIds.clear();
    refreshSize();
    update();
    emit modelChanged();
    emit selectionChanged();
}

void TimelineWidget::toggleSelectedEnabled()
{
    const QString id = selectedClipId();
    Clip* clip = m_model->findClip(id);
    if (!clip)
        return;
    clip->enabled = !clip->enabled;
    update();
    emit modelChanged();
}

void TimelineWidget::disconnectSelected()
{
    const QString id = selectedClipId();
    if (id.isEmpty())
        return;
    if (m_model->disconnectClip(id)) {
        update();
        emit modelChanged();
    }
}

void TimelineWidget::groupSelectedAsStoryline()
{
    QList<QString> connected;
    for (const QString& id : m_selectedClipIds) {
        const Clip* clip = m_model->findClip(id);
        if (clip && clip->connected)
            connected.append(id);
    }
    if (connected.size() < 2)
        return;
    if (!m_model->createStoryline(QStringLiteral("次要故事情节"), connected).isEmpty()) {
        update();
        emit modelChanged();
    }
}

void TimelineWidget::addTransitionAtBoundary(const QString& leftClipId, TransitionType type)
{
    Transition transition;
    transition.type = type;
    transition.setDuration(Transition::kDefaultDuration);
    if (m_model->setTransition(leftClipId, transition)) {
        m_selectedTransitionLeftId = leftClipId;
        update();
        emit modelChanged();
        emit selectionChanged();
    }
}

void TimelineWidget::selectClip(const QString& clipId, bool additive)
{
    if (clipId.isEmpty()) {
        clearSelection();
        return;
    }
    if (additive) {
        if (m_selectedClipIds.contains(clipId))
            m_selectedClipIds.removeAll(clipId);
        else
            m_selectedClipIds.append(clipId);
    } else {
        m_selectedClipIds = { clipId };
    }
    m_selectedTransitionLeftId.clear();
    update();
    emit selectionChanged();
}

// -------------------------------------------------------------------- paint

void TimelineWidget::paintEvent(QPaintEvent* /*event*/)
{
    QPainter p(this);
    p.fillRect(rect(), QColor(30, 30, 32));
    const QList<TimelineLane> lanes = m_model->computeLanes();
    const double total = m_model->totalDuration();

    // Ruler.
    p.fillRect(0, 0, width(), kRulerHeight, QColor(45, 45, 48));
    p.setPen(QColor(200, 200, 200));
    const double minorStep = 0.25;
    const int firstMajor = 0;
    for (double t = 0.0; t <= total + 1.0; t += minorStep) {
        const int x = xAtTime(t);
        if (x < kGutterWidth)
            continue;
        const bool major = std::fabs(std::fmod(t, 1.0)) < 1e-9;
        p.drawLine(x, major ? kRulerHeight - 12 : kRulerHeight - 5, x, kRulerHeight);
        if (major && t >= firstMajor)
            p.drawText(x + 3, 14, formatTime(t));
    }

    // Lanes.
    for (int li = 0; li < lanes.size(); ++li) {
        const int top = laneTopY(li);
        const int h = laneHeight(lanes[li]);
        p.fillRect(0, top, width(), h,
                   li == 0 ? QColor(38, 38, 40) : QColor(34, 34, 36));
        p.setPen(QColor(70, 70, 74));
        p.drawLine(0, top + h - 1, width(), top + h - 1);
        // Lane label in the gutter.
        p.setPen(QColor(180, 180, 180));
        p.drawText(QRect(6, top, kGutterWidth - 12, h),
                   Qt::AlignLeft | Qt::AlignVCenter,
                   lanes[li].label);
    }

    // Clips.
    auto drawClip = [&](const Clip& clip, bool isPrimary) {
        const int lane = isPrimary ? 0 : m_model->laneIndexOf(clip.id);
        if (lane < 0)
            return;
        double start = clip.timelineStart;
        double end = clip.timelineEnd();
        if (m_dragMode == DragMode::MoveClip && clip.id == m_dragClipId) {
            const double d = m_dragPreviewTime - clip.timelineStart;
            start += d;
            end += d;
        } else if ((m_dragMode == DragMode::TrimLeft || m_dragMode == DragMode::TrimRight)
                   && clip.id == m_dragClipId) {
            if (m_dragMode == DragMode::TrimLeft)
                start = m_dragPreviewTime;
            else
                end = m_dragPreviewTime;
        }
        const int top = laneTopY(lane);
        const int h = laneHeight(lanes[lane]);
        const QRect block(xAtTime(start), top + 3, std::max(2, xAtTime(end) - xAtTime(start)), h - 6);
        QColor fill = roleColor(clip.role);
        if (isPrimary)
            fill = fill.lighter(115);
        if (!clip.enabled)
            fill = QColor(110, 110, 110);
        p.fillRect(block, fill);
        const bool selected = m_selectedClipIds.contains(clip.id);
        p.setPen(selected ? QColor(255, 255, 255) : QColor(20, 20, 20));
        p.drawRect(block.adjusted(0, 0, -1, -1));
        p.setPen(clip.enabled ? QColor(255, 255, 255) : QColor(200, 200, 200));
        const QString label = clipDisplayName(clip)
            + (clip.enabled ? QString() : QStringLiteral("（已禁用）"));
        p.drawText(block.adjusted(5, 0, -5, 0), Qt::AlignLeft | Qt::AlignVCenter,
                   p.fontMetrics().elidedText(label, Qt::ElideRight, block.width() - 10));
    };
    for (const Clip& clip : m_model->primaryClips())
        drawClip(clip, true);
    for (const Clip& clip : m_model->connectedClips())
        drawClip(clip, false);

    // Transitions on primary boundaries.
    for (int i = 0; i + 1 < m_model->primaryClips().size(); ++i) {
        const Clip& left = m_model->primaryClips()[i];
        const Transition* t = m_model->transitionAfter(left.id);
        if (!t)
            continue;
        const int bx = xAtTime(left.timelineEnd());
        const int top = laneTopY(0);
        const int h = laneHeight(lanes[0]);
        const bool selected = m_selectedTransitionLeftId == left.id;
        p.setPen(selected ? QColor(255, 220, 120) : QColor(230, 230, 230));
        p.setBrush(selected ? QColor(255, 220, 120) : QColor(230, 230, 230));
        const QPoint pts[4] = { QPoint(bx, top + 4), QPoint(bx + 6, top + h / 2),
                                QPoint(bx, top + h - 4), QPoint(bx - 6, top + h / 2) };
        p.drawPolygon(pts, 4);
    }

    // Playhead.
    const int px = xAtTime(m_playhead);
    p.setPen(QColor(255, 70, 70));
    p.drawLine(px, 0, px, height());
    p.setBrush(QColor(255, 70, 70));
    const QPoint head[3] = { QPoint(px - 6, 0), QPoint(px + 6, 0), QPoint(px, 10) };
    p.drawPolygon(head, 3);
}

// -------------------------------------------------------------------- mouse

void TimelineWidget::mousePressEvent(QMouseEvent* event)
{
    m_pressPos = event->pos();
    setFocus(Qt::MouseFocusReason);
    if (event->button() != Qt::LeftButton)
        return;
    if (event->pos().y() < kRulerHeight) {
        m_dragMode = DragMode::Scrub;
        setPlayhead(timeAtX(event->pos().x()));
        return;
    }
    const HitClip hit = hitClipAt(event->pos());
    if (hit.clipId.isEmpty()) {
        // Clicking empty space clears the selection; a boundary click
        // selects its transition.
        double cut = 0.0;
        QString leftId;
        if (boundaryNearX(event->pos().x(), cut, leftId)) {
            m_selectedTransitionLeftId = leftId;
            m_selectedClipIds.clear();
            update();
            emit selectionChanged();
            return;
        }
        clearSelection();
        return;
    }
    selectClip(hit.clipId, event->modifiers() & Qt::ControlModifier);
    const Clip* clip = m_model->findClip(hit.clipId);
    if (!clip)
        return;
    m_dragClipId = hit.clipId;
    m_dragClipPrimary = hit.isPrimary;
    m_dragStartTime = timeAtX(event->pos().x());
    m_dragGrabOffset = m_dragStartTime - clip->timelineStart;
    m_dragPreviewTime = clip->timelineStart;
    if (hit.leftEdge) {
        m_dragMode = DragMode::TrimLeft;
        m_dragPreviewTime = clip->timelineStart;
    } else if (hit.rightEdge) {
        m_dragMode = DragMode::TrimRight;
        m_dragPreviewTime = clip->timelineEnd();
        m_dragRoll = (event->modifiers() & Qt::ControlModifier) && hit.isPrimary;
    } else {
        m_dragMode = DragMode::MoveClip;
    }
}

void TimelineWidget::mouseMoveEvent(QMouseEvent* event)
{
    if (m_dragMode == DragMode::None)
        return;
    const double t = timeAtX(event->pos().x());
    if (m_dragMode == DragMode::Scrub) {
        setPlayhead(t);
        return;
    }
    const Clip* clip = m_model->findClip(m_dragClipId);
    if (!clip)
        return;
    if (m_dragMode == DragMode::MoveClip) {
        m_dragPreviewTime = snapTime(t - m_dragGrabOffset);
        if (m_dragPreviewTime < 0.0)
            m_dragPreviewTime = 0.0;
    } else if (m_dragMode == DragMode::TrimLeft) {
        m_dragPreviewTime = snapTime(t);
        m_dragPreviewTime = std::clamp(m_dragPreviewTime, 0.0,
                                       clip->timelineEnd() - TimelineModel::kMinClipDuration);
    } else if (m_dragMode == DragMode::TrimRight) {
        m_dragPreviewTime = snapTime(t);
        m_dragPreviewTime = std::max(m_dragPreviewTime,
                                     clip->timelineStart + TimelineModel::kMinClipDuration);
    }
    update();
}

void TimelineWidget::mouseReleaseEvent(QMouseEvent* event)
{
    if (event->button() != Qt::LeftButton)
        return;
    if (m_dragMode == DragMode::None)
        return;
    const DragMode mode = m_dragMode;
    m_dragMode = DragMode::None;
    Clip* clip = m_model->findClip(m_dragClipId);
    if (!clip) {
        m_dragClipId.clear();
        return;
    }
    const QString id = m_dragClipId;
    const double preview = m_dragPreviewTime;
    m_dragClipId.clear();
    if (mode == DragMode::MoveClip) {
        if (m_dragClipPrimary) {
            m_model->movePrimaryClip(id, preview);
        } else if (!clip->storylineId.isEmpty()) {
            m_model->moveStoryline(clip->storylineId, preview - clip->timelineStart);
        } else {
            m_model->moveConnectedClip(id, preview - clip->timelineStart);
        }
    } else if (mode == DragMode::TrimLeft) {
        m_model->rippleTrimStart(id, preview - clip->timelineStart);
    } else if (mode == DragMode::TrimRight) {
        const double delta = preview - clip->timelineEnd();
        if (m_dragRoll && m_dragClipPrimary) {
            const int index = m_model->primaryIndexOf(id);
            if (!m_model->rollTrim(index, delta))
                m_model->rippleTrimEnd(id, delta);
        } else {
            m_model->rippleTrimEnd(id, delta);
        }
    }
    m_dragRoll = false;
    refreshSize();
    update();
    emit modelChanged();
}

void TimelineWidget::mouseDoubleClickEvent(QMouseEvent* event)
{
    double cut = 0.0;
    QString leftId;
    if (boundaryNearX(event->pos().x(), cut, leftId))
        addTransitionAtBoundary(leftId, TransitionType::Dissolve);
}

void TimelineWidget::keyPressEvent(QKeyEvent* event)
{
    if ((event->modifiers() & Qt::ControlModifier) && event->key() == Qt::Key_B) {
        splitAtPlayhead();
        event->accept();
        return;
    }
    if (event->key() == Qt::Key_Delete || event->key() == Qt::Key_Backspace) {
        rippleDeleteSelected();
        event->accept();
        return;
    }
    if (event->key() == Qt::Key_V) {
        toggleSelectedEnabled();
        event->accept();
        return;
    }
    if (event->key() == Qt::Key_D) {
        disconnectSelected();
        event->accept();
        return;
    }
    QWidget::keyPressEvent(event);
}

void TimelineWidget::dragEnterEvent(QDragEnterEvent* event)
{
    if (event->mimeData()->hasFormat(QStringLiteral("application/x-catcut-transition"))
        || event->mimeData()->hasFormat(QStringLiteral("application/x-catcut-media-path"))
        || event->mimeData()->hasUrls()) {
        event->acceptProposedAction();
        return;
    }
    event->ignore();
}

void TimelineWidget::dropEvent(QDropEvent* event)
{
    const QMimeData* mime = event->mimeData();
    const QPoint pos = event->position().toPoint();
    m_pressPos = pos;
    if (mime->hasFormat(QStringLiteral("application/x-catcut-transition"))) {
        const int type = mime->data(QStringLiteral("application/x-catcut-transition")).toInt();
        double cut = 0.0;
        QString leftId;
        if (boundaryNearX(pos.x(), cut, leftId)
            && type >= 0 && type < static_cast<int>(demoTransitionTypes().size())) {
            addTransitionAtBoundary(leftId, demoTransitionTypes()[type]);
            event->acceptProposedAction();
            return;
        }
        event->ignore();
        return;
    }
    QString path;
    if (mime->hasFormat(QStringLiteral("application/x-catcut-media-path"))) {
        path = QString::fromUtf8(mime->data(QStringLiteral("application/x-catcut-media-path")));
    } else if (mime->hasUrls()) {
        for (const QUrl& url : mime->urls()) {
            if (url.isLocalFile()) {
                path = url.toLocalFile();
                break;
            }
        }
    }
    if (path.isEmpty()) {
        event->ignore();
        return;
    }
    if (!addMediaAt(path, timeAtX(pos.x())).isEmpty())
        event->acceptProposedAction();
    else
        event->ignore();
}

void TimelineWidget::contextMenuEvent(QContextMenuEvent* event)
{
    const HitClip hit = hitClipAt(event->pos());
    QMenu menu(this);
    if (!hit.clipId.isEmpty()) {
        selectClip(hit.clipId, false);
        menu.addAction(QStringLiteral("在播放头处分割 (Ctrl+B)"), this, [this]() { splitAtPlayhead(); });
        menu.addAction(QStringLiteral("波纹删除 (Delete)"), this, [this]() { rippleDeleteSelected(); });
        const Clip* clip = m_model->findClip(hit.clipId);
        menu.addAction(clip && clip->enabled ? QStringLiteral("禁用 (V)") : QStringLiteral("启用 (V)"),
                       this, [this]() { toggleSelectedEnabled(); });
        if (clip && clip->connected)
            menu.addAction(QStringLiteral("断开连接（保持原地）(D)"), this, [this]() { disconnectSelected(); });
        menu.addSeparator();
        QMenu* transitionMenu = menu.addMenu(QStringLiteral("在下一个交界处加转场"));
        for (TransitionType type : demoTransitionTypes()) {
            transitionMenu->addAction(transitionDisplayName(type), this, [this, hit, type]() {
                addTransitionAtBoundary(hit.clipId, type);
            });
        }
    } else {
        menu.addAction(QStringLiteral("添加标题…"), this, [this, event]() {
            addTitleAt(QStringLiteral("标题"), timeAtX(event->pos().x()));
        });
    }
    menu.addSeparator();
    menu.addAction(QStringLiteral("把选中的连接片段打包为次要故事情节"), this,
                   [this]() { groupSelectedAsStoryline(); });
    menu.exec(event->globalPos());
}

bool TimelineWidget::eventFilter(QObject* watched, QEvent* event)
{
    if (event->type() == QEvent::MouseButtonPress) {
        for (int i = 0; i < m_paletteButtons.size(); ++i) {
            if (watched == m_paletteButtons[i]) {
                startPaletteDrag(m_paletteButtons[i], demoTransitionTypes()[i]);
                return true;
            }
        }
    }
    return QWidget::eventFilter(watched, event);
}

void TimelineWidget::startPaletteDrag(QWidget* button, TransitionType type)
{
    auto* drag = new QDrag(button);
    auto* mime = new QMimeData();
    mime->setData(QStringLiteral("application/x-catcut-transition"),
                  QByteArray::number(static_cast<int>(type)));
    mime->setText(transitionDisplayName(type));
    drag->setMimeData(mime);
    drag->exec(Qt::CopyAction);
}

QWidget* TimelineWidget::createToolbar()
{
    auto* toolbar = new QWidget();
    auto* layout = new QHBoxLayout(toolbar);
    layout->setContentsMargins(2, 2, 2, 2);
    layout->addWidget(new QLabel(QStringLiteral("缩放：")));
    auto* zoom = new QSlider(Qt::Horizontal);
    zoom->setRange(10, 400);
    zoom->setValue(static_cast<int>(m_pxPerSecond));
    zoom->setMaximumWidth(140);
    connect(zoom, &QSlider::valueChanged, this, [this](int value) { setPixelsPerSecond(value); });
    layout->addWidget(zoom);

    auto* playButton = new QPushButton(QStringLiteral("播放/暂停"));
    connect(playButton, &QPushButton::clicked, this, [this]() { setPlaying(!m_playing); });
    layout->addWidget(playButton);
    auto* splitButton = new QPushButton(QStringLiteral("分割 (Ctrl+B)"));
    connect(splitButton, &QPushButton::clicked, this, [this]() { splitAtPlayhead(); });
    layout->addWidget(splitButton);
    auto* deleteButton = new QPushButton(QStringLiteral("波纹删除"));
    connect(deleteButton, &QPushButton::clicked, this, [this]() { rippleDeleteSelected(); });
    layout->addWidget(deleteButton);
    auto* titleButton = new QPushButton(QStringLiteral("添加标题"));
    connect(titleButton, &QPushButton::clicked, this, [this]() { addTitleAt(QStringLiteral("标题"), m_playhead); });
    layout->addWidget(titleButton);

    layout->addWidget(new QLabel(QStringLiteral("转场（拖到交界处）：")));
    const QList<TransitionType> types = demoTransitionTypes();
    for (int i = 0; i < types.size(); ++i) {
        auto* button = new QToolButton();
        button->setText(transitionDisplayName(types[i]));
        button->setToolTip(QStringLiteral("拖到两个片段的交界处"));
        button->installEventFilter(this);
        m_paletteButtons.append(button);
        layout->addWidget(button);
    }
    layout->addStretch();
    return toolbar;
}

} // namespace catcut
