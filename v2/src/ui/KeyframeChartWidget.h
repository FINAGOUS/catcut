// CatCut v2 — S2 timeline: keyframe chart view.
//
// Bezier curve editor for one keyframe track of the selected clip:
// the curve is drawn by sampling KeyframeTrack::valueAt, keyframes are
// diamonds, Bezier handles are draggable dots on tangent lines.
// Double-click adds a keyframe, right-click a keyframe deletes it,
// dragging a point moves (time, value), dragging a handle reshapes
// the curve. The parameter is chosen with setParameter(); the clip is
// re-fetched from the model by id on every event, so model edits
// elsewhere cannot leave a dangling pointer behind.

#pragma once

#include <QList>
#include <QString>
#include <QWidget>

#include "core/TimelineModel.h"

namespace catcut {

class KeyframeChartWidget : public QWidget {
    Q_OBJECT
public:
    explicit KeyframeChartWidget(QWidget* parent = nullptr);

    void setModel(TimelineModel* model) { m_model = model; }
    void setClip(const QString& clipId);
    void setParameter(const QString& parameter); // x/y/scale/rotation/opacity/volume
    QString parameter() const { return m_parameter; }
    QString clipId() const { return m_clipId; }

    // Parameter names in combo-box order.
    static QList<QString> parameterNames();
    static QString parameterDisplayName(const QString& parameter);

signals:
    void keyframesChanged();

protected:
    void paintEvent(QPaintEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void mouseMoveEvent(QMouseEvent* event) override;
    void mouseReleaseEvent(QMouseEvent* event) override;
    void mouseDoubleClickEvent(QMouseEvent* event) override;

private:
    const KeyframeTrack* trackForClip(const Clip& clip) const;
    KeyframeTrack* mutableTrackForClip(Clip& clip);
    double trackDefault(const Clip& clip) const;
    // Value range shown (auto from keyframes, padded, never degenerate).
    void valueRange(double& minOut, double& maxOut) const;
    QPointF pointFor(double time, double value) const;
    double timeAtX(int x) const;
    double valueAtY(int y) const;
    // Hit test: returns keyframe time, or -1; `handleOut` set when a
    // handle (not the point) was hit.
    double hitKeyframe(const QPoint& pos, bool& handleOut) const;

    TimelineModel* m_model = nullptr;
    QString m_clipId;
    QString m_parameter = QStringLiteral("opacity");

    double m_dragKeyframeTime = -1.0;
    bool m_dragHandle = false;
    bool m_dragHandleOut = true;
    bool m_dragging = false;
};

} // namespace catcut
