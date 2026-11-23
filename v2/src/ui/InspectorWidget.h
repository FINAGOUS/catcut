// CatCut v2 — S3 colour & picture: inspector.
//
// Context panel for the current selection: clip properties (role,
// enabled, geometry at the playhead) and, when a transition is
// selected, its type and duration (0.1–5s, default 0.5s). Geometry
// edits write a keyframe at the playhead's clip-local time — the
// inspector never stores a separate "base value" that could disagree
// with the keyframe tracks. The disconnect button is the escape hatch
// (see TimelineModel::disconnectClip).
//
// S3: the inspector is tabbed — "片段" (the S2 form) and "调色"
// (the shared ColorPanelWidget: grade / beauty / keying / canvas /
// motion + live scopes). The same panel also lives as its own
// detachable dock in MainWindow; both edit the same model.

#pragma once

#include <QImage>
#include <QString>
#include <QWidget>

#include "core/TimelineModel.h"

class QCheckBox;
class QComboBox;
class QDoubleSpinBox;
class QLabel;
class QPushButton;

namespace catcut {

class ColorPanelWidget;

class InspectorWidget : public QWidget {
    Q_OBJECT
public:
    explicit InspectorWidget(QWidget* parent = nullptr);

    void setModel(TimelineModel* model);
    // Refreshes from the current selection. `playheadSeconds` is the
    // timeline time the geometry spinboxes read/write keyframes at.
    void refresh(const QString& clipId, const QString& transitionLeftId,
                 double playheadSeconds);
    // Graded frame for the colour tab's scopes.
    void setScopesImage(const QImage& image);

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
    ColorPanelWidget* m_colorPanel = nullptr;
};

} // namespace catcut
