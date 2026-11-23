// CatCut v2 — S3 colour & picture: colour panel + scopes.
//
// One widget, two homes (architecture doc section 6): it is the
// "调色" page inside the inspector AND a detachable dock panel
// ("调色" dock in MainWindow). Both instances edit the same model —
// the selected clip's grade / beauty / chroma key / mask, plus the
// project-level canvas style and camera motion — and both refresh on
// selection / playhead changes.
//
// The scopes (waveform / vectorscope / histogram) are computed on the
// CPU from the graded frame handed in via setScopesImage() and drawn
// beside the controls; they are analysis, not a second grade path.

#pragma once

#include <QImage>
#include <QWidget>

#include "core/ColorGrade.h"

class QCheckBox;
class QComboBox;
class QDoubleSpinBox;
class QLabel;
class QPushButton;
class QSlider;

namespace catcut {

class TimelineModel;

// Small scopes display: histogram (top), waveform (middle),
// vectorscope (bottom), painted from a ColorScopes snapshot.
class ScopesWidget : public QWidget {
    Q_OBJECT
public:
    explicit ScopesWidget(QWidget* parent = nullptr);
    void setImage(const QImage& image);
    QSize sizeHint() const override { return QSize(280, 260); }

protected:
    void paintEvent(QPaintEvent* event) override;

private:
    ColorScopes m_scopes;
    bool m_hasScopes = false;
};

class ColorPanelWidget : public QWidget {
    Q_OBJECT
public:
    explicit ColorPanelWidget(QWidget* parent = nullptr);

    void setModel(TimelineModel* model) { m_model = model; }
    // Refreshes every control from the selected clip (`clipId` may be
    // empty: clip sections disable, project sections stay live).
    void refresh(const QString& clipId, double playheadSeconds);
    // Graded frame for the scopes (set by MainWindow on every preview
    // render; a small image is enough).
    void setScopesImage(const QImage& image);

signals:
    void changed();

private:
    void applyProjectSettings();
    void rebuildLutLabel();

    TimelineModel* m_model = nullptr;
    QString m_clipId;
    double m_playhead = 0.0;
    bool m_refreshing = false;
    ScopesWidget* m_scopes = nullptr;

    // White balance.
    QSlider* m_tempSlider = nullptr;
    QSlider* m_tintSlider = nullptr;
    // Wheels: [wheel][channel] sliders, wheels 0..3 = shadows/mids/highs/global.
    QSlider* m_wheelSliders[4][3] = {};
    // Curves: [channel][point] output spinboxes (x fixed 0/.25/.5/.75/1).
    QDoubleSpinBox* m_curveSpins[4][5] = {};
    // HSL zones: [zone][hueShift/sat/light] spinboxes.
    QDoubleSpinBox* m_hslSpins[7][3] = {};
    QLabel* m_lutLabel = nullptr;
    // Beauty.
    QCheckBox* m_beautyCheck = nullptr;
    QSlider* m_beautyStrengthSlider = nullptr;
    QSlider* m_beautyBrightenSlider = nullptr;
    // Chroma key + mask.
    QCheckBox* m_keyCheck = nullptr;
    QPushButton* m_keyColourButton = nullptr;
    QSlider* m_keyToleranceSlider = nullptr;
    QSlider* m_keySoftnessSlider = nullptr;
    QComboBox* m_maskCombo = nullptr;
    QDoubleSpinBox* m_maskFeatherSpin = nullptr;
    // Canvas.
    QDoubleSpinBox* m_cropSpins[4] = {};
    QSlider* m_paddingSlider = nullptr;
    QSlider* m_cornerSlider = nullptr;
    QSlider* m_strokeSlider = nullptr;
    QSlider* m_shadowSlider = nullptr;
    QComboBox* m_frameCombo = nullptr;
    QCheckBox* m_frameLandscapeCheck = nullptr;
    // Motion.
    QCheckBox* m_autoZoomCheck = nullptr;
    QLabel* m_autoZoomLabel = nullptr;
    QDoubleSpinBox* m_springStiffnessSpin = nullptr;
    QDoubleSpinBox* m_springDampingSpin = nullptr;
    QSlider* m_tiltXSlider = nullptr;
    QSlider* m_tiltYSlider = nullptr;
    QSlider* m_rotZSlider = nullptr;
    QSlider* m_perspSlider = nullptr;
    QSlider* m_size3DSlider = nullptr;
    QCheckBox* m_zoomFocusCheck = nullptr;
    QCheckBox* m_3dFocusCheck = nullptr;
};

} // namespace catcut
