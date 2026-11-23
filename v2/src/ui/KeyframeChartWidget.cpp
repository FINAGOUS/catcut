#include "ui/KeyframeChartWidget.h"

#include <QMouseEvent>
#include <QPainter>

#include <algorithm>
#include <cmath>

namespace catcut {

namespace {
constexpr int kPadLeft = 44;
constexpr int kPadRight = 12;
constexpr int kPadTop = 10;
constexpr int kPadBottom = 20;
constexpr int kHitRadius = 7;
} // namespace

KeyframeChartWidget::KeyframeChartWidget(QWidget* parent)
    : QWidget(parent)
{
    setMinimumHeight(140);
    setMouseTracking(true);
}

QList<QString> KeyframeChartWidget::parameterNames()
{
    return { QStringLiteral("x"), QStringLiteral("y"), QStringLiteral("scale"),
             QStringLiteral("rotation"), QStringLiteral("opacity"),
             QStringLiteral("volume") };
}

QString KeyframeChartWidget::parameterDisplayName(const QString& parameter)
{
    if (parameter == QStringLiteral("x"))
        return QStringLiteral("位置 X");
    if (parameter == QStringLiteral("y"))
        return QStringLiteral("位置 Y");
    if (parameter == QStringLiteral("scale"))
        return QStringLiteral("缩放");
    if (parameter == QStringLiteral("rotation"))
        return QStringLiteral("旋转");
    if (parameter == QStringLiteral("opacity"))
        return QStringLiteral("不透明度");
    if (parameter == QStringLiteral("volume"))
        return QStringLiteral("音量");
    return parameter;
}

void KeyframeChartWidget::setClip(const QString& clipId)
{
    m_clipId = clipId;
    m_dragging = false;
    update();
}

void KeyframeChartWidget::setParameter(const QString& parameter)
{
    if (parameterNames().contains(parameter))
        m_parameter = parameter;
    update();
}

const KeyframeTrack* KeyframeChartWidget::trackForClip(const Clip& clip) const
{
    if (m_parameter == QStringLiteral("x"))
        return &clip.keyframes.positionX;
    if (m_parameter == QStringLiteral("y"))
        return &clip.keyframes.positionY;
    if (m_parameter == QStringLiteral("scale"))
        return &clip.keyframes.scale;
    if (m_parameter == QStringLiteral("rotation"))
        return &clip.keyframes.rotation;
    if (m_parameter == QStringLiteral("opacity"))
        return &clip.keyframes.opacity;
    return clip.keyframes.effectTrackOrNull(QStringLiteral("volume"));
}

KeyframeTrack* KeyframeChartWidget::mutableTrackForClip(Clip& clip)
{
    if (m_parameter == QStringLiteral("x"))
        return &clip.keyframes.positionX;
    if (m_parameter == QStringLiteral("y"))
        return &clip.keyframes.positionY;
    if (m_parameter == QStringLiteral("scale"))
        return &clip.keyframes.scale;
    if (m_parameter == QStringLiteral("rotation"))
        return &clip.keyframes.rotation;
    if (m_parameter == QStringLiteral("opacity"))
        return &clip.keyframes.opacity;
    return &clip.keyframes.effectTrack(QStringLiteral("volume"), 1.0);
}

double KeyframeChartWidget::trackDefault(const Clip& clip) const
{
    const KeyframeTrack* track = trackForClip(clip);
    if (track)
        return track->defaultValue();
    return m_parameter == QStringLiteral("volume") ? 1.0 : 0.0;
}

void KeyframeChartWidget::valueRange(double& minOut, double& maxOut) const
{
    minOut = 0.0;
    maxOut = 1.0;
    if (!m_model)
        return;
    const Clip* clip = m_model->findClip(m_clipId);
    if (!clip)
        return;
    const KeyframeTrack* track = trackForClip(*clip);
    double lo = track ? track->defaultValue() : 0.0;
    double hi = lo;
    if (track) {
        for (const Keyframe& k : track->keyframes()) {
            lo = std::min(lo, k.value);
            hi = std::max(hi, k.value);
        }
    }
    const double pad = std::max(0.1, (hi - lo) * 0.2);
    minOut = lo - pad;
    maxOut = hi + pad;
    if (maxOut - minOut < 1e-6) {
        minOut -= 0.5;
        maxOut += 0.5;
    }
}

QPointF KeyframeChartWidget::pointFor(double time, double value) const
{
    const Clip* clip = m_model ? m_model->findClip(m_clipId) : nullptr;
    const double duration = clip ? std::max(0.1, clip->duration()) : 1.0;
    double vMin = 0.0, vMax = 1.0;
    valueRange(vMin, vMax);
    const double x = kPadLeft + (width() - kPadLeft - kPadRight) * std::clamp(time / duration, 0.0, 1.0);
    const double y = kPadTop + (height() - kPadTop - kPadBottom)
        * (1.0 - (value - vMin) / (vMax - vMin));
    return QPointF(x, y);
}

double KeyframeChartWidget::timeAtX(int x) const
{
    const Clip* clip = m_model ? m_model->findClip(m_clipId) : nullptr;
    const double duration = clip ? std::max(0.1, clip->duration()) : 1.0;
    const double frac = std::clamp(
        static_cast<double>(x - kPadLeft) / std::max(1, width() - kPadLeft - kPadRight), 0.0, 1.0);
    return frac * duration;
}

double KeyframeChartWidget::valueAtY(int y) const
{
    double vMin = 0.0, vMax = 1.0;
    valueRange(vMin, vMax);
    const double frac = std::clamp(
        static_cast<double>(y - kPadTop) / std::max(1, height() - kPadTop - kPadBottom), 0.0, 1.0);
    return vMin + (1.0 - frac) * (vMax - vMin);
}

double KeyframeChartWidget::hitKeyframe(const QPoint& pos, bool& handleOut) const
{
    handleOut = true;
    if (!m_model)
        return -1.0;
    const Clip* clip = m_model->findClip(m_clipId);
    if (!clip)
        return -1.0;
    const KeyframeTrack* track = trackForClip(*clip);
    if (!track)
        return -1.0;
    for (const Keyframe& k : track->keyframes()) {
        const QPointF pt = pointFor(k.time, k.value);
        if (std::hypot(pos.x() - pt.x(), pos.y() - pt.y()) <= kHitRadius)
            return k.time;
        // Handles: out-handle to the right, in-handle to the left.
        if (k.interpolation == KeyframeInterpolation::Bezier) {
            const QPointF outPt = pointFor(k.time + k.outDx, k.value + k.outDy);
            if (std::hypot(pos.x() - outPt.x(), pos.y() - outPt.y()) <= kHitRadius) {
                handleOut = true;
                return k.time;
            }
            const QPointF inPt = pointFor(k.time + k.inDx, k.value + k.inDy);
            if (std::hypot(pos.x() - inPt.x(), pos.y() - inPt.y()) <= kHitRadius) {
                handleOut = false;
                return k.time;
            }
        }
    }
    return -1.0;
}

void KeyframeChartWidget::paintEvent(QPaintEvent* /*event*/)
{
    QPainter p(this);
    p.fillRect(rect(), QColor(28, 28, 30));
    if (!m_model || m_clipId.isEmpty()) {
        p.setPen(QColor(150, 150, 150));
        p.drawText(rect(), Qt::AlignCenter, QStringLiteral("未选中片段"));
        return;
    }
    const Clip* clip = m_model->findClip(m_clipId);
    if (!clip) {
        p.setPen(QColor(150, 150, 150));
        p.drawText(rect(), Qt::AlignCenter, QStringLiteral("片段已删除"));
        return;
    }
    const KeyframeTrack* track = trackForClip(*clip);
    double vMin = 0.0, vMax = 1.0;
    valueRange(vMin, vMax);

    // Grid + labels.
    p.setPen(QColor(60, 60, 64));
    for (int i = 0; i <= 4; ++i) {
        const double v = vMin + (vMax - vMin) * i / 4.0;
        const int y = static_cast<int>(pointFor(0.0, v).y());
        p.drawLine(kPadLeft, y, width() - kPadRight, y);
        p.setPen(QColor(150, 150, 150));
        p.drawText(4, y + 4, QString::number(v, 'f', 2));
        p.setPen(QColor(60, 60, 64));
    }
    p.setPen(QColor(150, 150, 150));
    p.drawText(kPadLeft, height() - 5, QStringLiteral("0s"));
    p.drawText(width() - kPadRight - 40, height() - 5,
               QStringLiteral("%1s").arg(clip->duration(), 0, 'f', 1));

    // Curve (sampled through the model's own interpolation).
    p.setPen(QPen(QColor(255, 200, 90), 2));
    const int samples = 100;
    QPointF prev;
    for (int i = 0; i <= samples; ++i) {
        const double t = clip->duration() * i / samples;
        const double v = track ? track->valueAt(t) : trackDefault(*clip);
        const QPointF pt = pointFor(t, v);
        if (i > 0)
            p.drawLine(prev, pt);
        prev = pt;
    }

    if (!track)
        return;
    // Handles then points.
    for (const Keyframe& k : track->keyframes()) {
        const QPointF pt = pointFor(k.time, k.value);
        if (k.interpolation == KeyframeInterpolation::Bezier) {
            p.setPen(QPen(QColor(160, 160, 160), 1));
            const QPointF outPt = pointFor(k.time + k.outDx, k.value + k.outDy);
            const QPointF inPt = pointFor(k.time + k.inDx, k.value + k.inDy);
            p.drawLine(pt, outPt);
            p.drawLine(pt, inPt);
            p.setBrush(QColor(200, 200, 200));
            p.drawEllipse(outPt, 3, 3);
            p.drawEllipse(inPt, 3, 3);
        }
    }
    for (const Keyframe& k : track->keyframes()) {
        const QPointF pt = pointFor(k.time, k.value);
        p.setBrush(QColor(255, 200, 90));
        p.setPen(QColor(30, 30, 30));
        const QPoint diamond[4] = {
            QPoint(static_cast<int>(pt.x()), static_cast<int>(pt.y()) - 6),
            QPoint(static_cast<int>(pt.x()) + 6, static_cast<int>(pt.y())),
            QPoint(static_cast<int>(pt.x()), static_cast<int>(pt.y()) + 6),
            QPoint(static_cast<int>(pt.x()) - 6, static_cast<int>(pt.y())),
        };
        p.drawPolygon(diamond, 4);
    }
}

void KeyframeChartWidget::mousePressEvent(QMouseEvent* event)
{
    if (!m_model || m_clipId.isEmpty())
        return;
    if (event->button() == Qt::RightButton) {
        bool handle = false;
        const double t = hitKeyframe(event->pos(), handle);
        if (t >= 0.0) {
            Clip* clip = m_model->findClip(m_clipId);
            KeyframeTrack* track = clip ? mutableTrackForClip(*clip) : nullptr;
            if (track && track->removeKeyframeAt(t)) {
                update();
                emit keyframesChanged();
            }
        }
        return;
    }
    if (event->button() != Qt::LeftButton)
        return;
    bool handleOut = true;
    const double t = hitKeyframe(event->pos(), handleOut);
    if (t < 0.0)
        return;
    // Distinguish point vs handle hit: re-check distance to the point.
    const Clip* clip = m_model->findClip(m_clipId);
    const KeyframeTrack* track = clip ? trackForClip(*clip) : nullptr;
    m_dragHandle = false;
    if (track) {
        for (const Keyframe& k : track->keyframes()) {
            if (std::fabs(k.time - t) < 1e-9) {
                const QPointF pt = pointFor(k.time, k.value);
                if (std::hypot(event->pos().x() - pt.x(), event->pos().y() - pt.y()) > kHitRadius)
                    m_dragHandle = true;
                break;
            }
        }
    }
    m_dragKeyframeTime = t;
    m_dragHandleOut = handleOut;
    m_dragging = true;
}

void KeyframeChartWidget::mouseMoveEvent(QMouseEvent* event)
{
    if (!m_dragging || !m_model)
        return;
    Clip* clip = m_model->findClip(m_clipId);
    KeyframeTrack* track = clip ? mutableTrackForClip(*clip) : nullptr;
    if (!clip || !track)
        return;
    const double t = timeAtX(event->pos().x());
    const double v = valueAtY(event->pos().y());
    if (m_dragHandle) {
        // Edit the handle on a copy of the keyframe, then re-add.
        QList<Keyframe> keys = track->keyframes();
        for (Keyframe& k : keys) {
            if (std::fabs(k.time - m_dragKeyframeTime) < 1e-9) {
                k.interpolation = KeyframeInterpolation::Bezier;
                if (m_dragHandleOut) {
                    k.outDx = std::clamp(t - k.time, 0.0, clip->duration() - k.time);
                    k.outDy = v - k.value;
                } else {
                    k.inDx = std::clamp(t - k.time, -k.time, 0.0);
                    k.inDy = v - k.value;
                }
                track->addKeyframe(k);
                break;
            }
        }
    } else {
        const double newTime = std::clamp(t, 0.0, clip->duration());
        double newValue = v;
        if (m_parameter == QStringLiteral("opacity") || m_parameter == QStringLiteral("volume"))
            newValue = std::clamp(v, 0.0, 2.0);
        if (m_parameter == QStringLiteral("scale"))
            newValue = std::max(0.05, v);
        track->moveKeyframe(m_dragKeyframeTime, newTime, newValue);
        m_dragKeyframeTime = newTime;
    }
    update();
    emit keyframesChanged();
}

void KeyframeChartWidget::mouseReleaseEvent(QMouseEvent* /*event*/)
{
    m_dragging = false;
    m_dragKeyframeTime = -1.0;
}

void KeyframeChartWidget::mouseDoubleClickEvent(QMouseEvent* event)
{
    if (!m_model || m_clipId.isEmpty() || event->button() != Qt::LeftButton)
        return;
    Clip* clip = m_model->findClip(m_clipId);
    KeyframeTrack* track = clip ? mutableTrackForClip(*clip) : nullptr;
    if (!clip || !track)
        return;
    const double t = std::clamp(timeAtX(event->pos().x()), 0.0, clip->duration());
    const double v = track->valueAt(t);
    Keyframe key;
    key.time = t;
    key.value = v;
    key.interpolation = KeyframeInterpolation::Bezier;
    key.outDx = 0.1;
    key.inDx = -0.1;
    track->addKeyframe(key);
    update();
    emit keyframesChanged();
}

} // namespace catcut
