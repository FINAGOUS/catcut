#include "ui/InspectorWidget.h"

#include <QCheckBox>
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QFormLayout>
#include <QLabel>
#include <QPushButton>
#include <QSignalBlocker>
#include <QTabWidget>
#include <QVBoxLayout>

#include <algorithm>
#include <cmath>

#include "ui/ColorPanelWidget.h"

namespace catcut {

InspectorWidget::InspectorWidget(QWidget* parent)
    : QWidget(parent)
{
    auto* layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);

    // S3: two tabs — "片段" (the S2 clip/transition form) and "调色"
    // (the shared colour panel, also available as its own dock).
    auto* tabs = new QTabWidget(this);
    auto* clipPage = new QWidget();
    auto* pageLayout = new QVBoxLayout(clipPage);
    pageLayout->setContentsMargins(6, 6, 6, 6);

    m_titleLabel = new QLabel(QStringLiteral("未选中任何片段"));
    m_titleLabel->setWordWrap(true);
    pageLayout->addWidget(m_titleLabel);

    // --- clip section ---
    m_clipSection = new QWidget();
    auto* form = new QFormLayout(m_clipSection);
    form->setContentsMargins(0, 0, 0, 0);

    m_roleCombo = new QComboBox();
    connect(m_roleCombo, &QComboBox::currentTextChanged, this, [this](const QString& role) {
        Clip* clip = m_model ? m_model->findClip(m_clipId) : nullptr;
        if (!clip || role.isEmpty())
            return;
        m_model->roleRegistry().addCustomRole(role);
        clip->role = role;
        emit changed();
    });
    form->addRow(QStringLiteral("角色"), m_roleCombo);

    m_enabledCheck = new QCheckBox(QStringLiteral("启用"));
    connect(m_enabledCheck, &QCheckBox::toggled, this, [this](bool checked) {
        Clip* clip = m_model ? m_model->findClip(m_clipId) : nullptr;
        if (!clip)
            return;
        clip->enabled = checked;
        emit changed();
    });
    form->addRow(QStringLiteral("状态"), m_enabledCheck);

    auto makeSpin = [](double min, double max, double step) {
        auto* spin = new QDoubleSpinBox();
        spin->setRange(min, max);
        spin->setSingleStep(step);
        spin->setDecimals(3);
        return spin;
    };
    m_opacitySpin = makeSpin(0.0, 1.0, 0.05);
    connect(m_opacitySpin, &QDoubleSpinBox::valueChanged, this,
            [this](double v) { applyGeometry(QStringLiteral("opacity"), v); });
    form->addRow(QStringLiteral("不透明度"), m_opacitySpin);

    m_scaleSpin = makeSpin(0.05, 4.0, 0.05);
    connect(m_scaleSpin, &QDoubleSpinBox::valueChanged, this,
            [this](double v) { applyGeometry(QStringLiteral("scale"), v); });
    form->addRow(QStringLiteral("缩放"), m_scaleSpin);

    m_rotationSpin = makeSpin(-180.0, 180.0, 1.0);
    connect(m_rotationSpin, &QDoubleSpinBox::valueChanged, this,
            [this](double v) { applyGeometry(QStringLiteral("rotation"), v); });
    form->addRow(QStringLiteral("旋转（°）"), m_rotationSpin);

    m_posXSpin = makeSpin(0.0, 1.0, 0.01);
    connect(m_posXSpin, &QDoubleSpinBox::valueChanged, this,
            [this](double v) { applyGeometry(QStringLiteral("x"), v); });
    form->addRow(QStringLiteral("位置 X"), m_posXSpin);

    m_posYSpin = makeSpin(0.0, 1.0, 0.01);
    connect(m_posYSpin, &QDoubleSpinBox::valueChanged, this,
            [this](double v) { applyGeometry(QStringLiteral("y"), v); });
    form->addRow(QStringLiteral("位置 Y"), m_posYSpin);

    m_disconnectButton = new QPushButton(QStringLiteral("断开连接（保持原地）"));
    connect(m_disconnectButton, &QPushButton::clicked, this, [this]() {
        if (m_model && m_model->disconnectClip(m_clipId))
            emit changed();
    });
    form->addRow(m_disconnectButton);

    m_keyframeParamCombo = new QComboBox();
    for (const QString& name : { QStringLiteral("opacity"), QStringLiteral("scale"),
                                 QStringLiteral("rotation"), QStringLiteral("x"),
                                 QStringLiteral("y"), QStringLiteral("volume") }) {
        m_keyframeParamCombo->addItem(name);
    }
    auto* keyframeButton = new QPushButton(QStringLiteral("在播放头处打关键帧"));
    connect(keyframeButton, &QPushButton::clicked, this, [this]() {
        applyGeometry(m_keyframeParamCombo->currentText(), -1.0); // -1 = keep current value
    });
    form->addRow(m_keyframeParamCombo, keyframeButton);

    pageLayout->addWidget(m_clipSection);

    // --- transition section ---
    m_transitionSection = new QWidget();
    auto* tForm = new QFormLayout(m_transitionSection);
    tForm->setContentsMargins(0, 0, 0, 0);
    m_transitionLabel = new QLabel();
    tForm->addRow(QStringLiteral("转场"), m_transitionLabel);
    m_transitionDurationSpin = new QDoubleSpinBox();
    m_transitionDurationSpin->setRange(Transition::kMinDuration, Transition::kMaxDuration);
    m_transitionDurationSpin->setSingleStep(0.1);
    m_transitionDurationSpin->setDecimals(2);
    m_transitionDurationSpin->setValue(Transition::kDefaultDuration);
    connect(m_transitionDurationSpin, &QDoubleSpinBox::valueChanged, this, [this](double v) {
        if (!m_model || m_transitionLeftId.isEmpty())
            return;
        const Transition* current = m_model->transitionAfter(m_transitionLeftId);
        if (!current)
            return;
        Transition updated = *current;
        updated.setDuration(v);
        m_model->setTransition(m_transitionLeftId, updated);
        emit changed();
    });
    tForm->addRow(QStringLiteral("时长（秒）"), m_transitionDurationSpin);
    pageLayout->addWidget(m_transitionSection);

    pageLayout->addStretch();
    tabs->addTab(clipPage, QStringLiteral("片段"));
    m_colorPanel = new ColorPanelWidget();
    connect(m_colorPanel, &ColorPanelWidget::changed, this, &InspectorWidget::changed);
    tabs->addTab(m_colorPanel, QStringLiteral("调色"));
    layout->addWidget(tabs);
    refresh(QString(), QString(), 0.0);
}

void InspectorWidget::rebuildRoleCombo(const QString& currentRole)
{
    const QSignalBlocker blocker(m_roleCombo);
    m_roleCombo->clear();
    if (m_model) {
        for (const QString& role : m_model->roleRegistry().roles())
            m_roleCombo->addItem(role);
    }
    if (!currentRole.isEmpty() && m_roleCombo->findText(currentRole) < 0)
        m_roleCombo->addItem(currentRole);
    m_roleCombo->setCurrentText(currentRole);
}

void InspectorWidget::setModel(TimelineModel* model)
{
    m_model = model;
    if (m_colorPanel)
        m_colorPanel->setModel(model);
}

void InspectorWidget::setScopesImage(const QImage& image)
{
    if (m_colorPanel)
        m_colorPanel->setScopesImage(image);
}

void InspectorWidget::refresh(const QString& clipId, const QString& transitionLeftId,
                              double playheadSeconds)
{
    m_clipId = clipId;
    m_transitionLeftId = transitionLeftId;
    m_playhead = playheadSeconds;
    // The colour tab stays live even with no clip selected (its
    // project sections — canvas / motion — do not need a clip).
    if (m_colorPanel)
        m_colorPanel->refresh(clipId, playheadSeconds);
    const Clip* clip = m_model ? m_model->findClip(clipId) : nullptr;
    const Transition* transition = m_model && !transitionLeftId.isEmpty()
        ? m_model->transitionAfter(transitionLeftId) : nullptr;

    m_clipSection->setVisible(clip != nullptr);
    m_transitionSection->setVisible(transition != nullptr);
    if (!clip && !transition) {
        m_titleLabel->setText(QStringLiteral("未选中任何片段"));
        return;
    }
    if (transition) {
        m_titleLabel->setText(QStringLiteral("转场：%1").arg(transitionDisplayName(transition->type)));
        m_transitionLabel->setText(transitionDisplayName(transition->type));
        const QSignalBlocker blocker(m_transitionDurationSpin);
        m_transitionDurationSpin->setValue(transition->duration);
    }
    if (!clip)
        return;
    m_titleLabel->setText(clip->name.isEmpty() ? QStringLiteral("片段") : clip->name);
    rebuildRoleCombo(clip->role);
    {
        const QSignalBlocker blocker(m_enabledCheck);
        m_enabledCheck->setChecked(clip->enabled);
    }
    m_disconnectButton->setEnabled(clip->connected);
    const double localTime = std::clamp(m_playhead - clip->timelineStart, 0.0, clip->duration());
    const QMap<QString, double> values = clip->keyframes.valuesAt(localTime);
    auto setSpin = [](QDoubleSpinBox* spin, double value) {
        const QSignalBlocker blocker(spin);
        spin->setValue(value);
    };
    setSpin(m_opacitySpin, values.value(QStringLiteral("opacity"), 1.0));
    setSpin(m_scaleSpin, values.value(QStringLiteral("scale"), 1.0));
    setSpin(m_rotationSpin, values.value(QStringLiteral("rotation"), 0.0));
    setSpin(m_posXSpin, values.value(QStringLiteral("x"), 0.5));
    setSpin(m_posYSpin, values.value(QStringLiteral("y"), 0.5));
}

void InspectorWidget::applyGeometry(const QString& parameter, double value)
{
    Clip* clip = m_model ? m_model->findClip(m_clipId) : nullptr;
    if (!clip)
        return;
    const double localTime = std::clamp(m_playhead - clip->timelineStart, 0.0, clip->duration());
    KeyframeTrack* track = nullptr;
    double current = 0.0;
    if (parameter == QStringLiteral("x")) {
        track = &clip->keyframes.positionX;
        current = track->valueAt(localTime);
    } else if (parameter == QStringLiteral("y")) {
        track = &clip->keyframes.positionY;
        current = track->valueAt(localTime);
    } else if (parameter == QStringLiteral("scale")) {
        track = &clip->keyframes.scale;
        current = track->valueAt(localTime);
    } else if (parameter == QStringLiteral("rotation")) {
        track = &clip->keyframes.rotation;
        current = track->valueAt(localTime);
    } else if (parameter == QStringLiteral("opacity")) {
        track = &clip->keyframes.opacity;
        current = track->valueAt(localTime);
    } else if (parameter == QStringLiteral("volume")) {
        track = &clip->keyframes.effectTrack(QStringLiteral("volume"), 1.0);
        current = track->valueAt(localTime);
    }
    if (!track)
        return;
    // value < 0 means "just place a keyframe at the current value"
    // (the "打关键帧" button); otherwise write the given value.
    Keyframe key;
    key.time = localTime;
    key.value = value < 0.0 ? current : value;
    key.interpolation = KeyframeInterpolation::Linear;
    track->addKeyframe(key);
    emit changed();
}

} // namespace catcut
