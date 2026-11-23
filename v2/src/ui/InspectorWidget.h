// CatCut v2 — S2 timeline: inspector.
//
// Context panel for the current selection: clip properties (role,
// enabled, geometry at the playhead) and, when a transition is
// selected, its type and duration (0.1–5s, default 0.5s). Geometry
// edits write a keyframe at the playhead's clip-local time — the
// inspector never stores a separate "base value" that could disagree
// with the keyframe tracks. The disconnect button is the escape hatch
// (see TimelineModel::disconnectClip).

#pragma once

#include <QString>
#include <QWidget>

#include "core/TimelineModel.h"

class QCheckBox;
class QComboBox;
class QDoubleSpinBox;
class QLabel;
class QPushButton;

namespace catcut {

class InspectorWidget : public QWidget {
    Q_OBJECT
public:
    explicit InspectorWidget(QWidget* parent = nullptr);

    void setModel(TimelineModel* model) { m_model = model; }
    // Refreshes from the current selection. `playheadSeconds` is the
    // timeline time the geometry spinboxes read/write keyframes at.
    void refresh(const QString& clipId, const QString& transitionLeftId,
                 double playheadSeconds);

signals:
    void changed();

private:
    void applyGeometry(const QString& parameter, double value);
    void rebuildRoleCombo(const QString& currentRole);

    TimelineModel* m_model = nullptr;
    QString m_clipId;
    QString m_transitionLeftId;
    double m_playhead = 0.0;

    QLabel* m_titleLabel = nullptr;
    QComboBox* m_roleCombo = nullptr;
    QCheckBox* m_enabledCheck = nullptr;
    QDoubleSpinBox* m_opacitySpin = nullptr;
    QDoubleSpinBox* m_scaleSpin = nullptr;
    QDoubleSpinBox* m_rotationSpin = nullptr;
    QDoubleSpinBox* m_posXSpin = nullptr;
    QDoubleSpinBox* m_posYSpin = nullptr;
    QPushButton* m_disconnectButton = nullptr;
    QComboBox* m_keyframeParamCombo = nullptr;
    QLabel* m_transitionLabel = nullptr;
    QDoubleSpinBox* m_transitionDurationSpin = nullptr;
    QWidget* m_clipSection = nullptr;
    QWidget* m_transitionSection = nullptr;
};

} // namespace catcut
