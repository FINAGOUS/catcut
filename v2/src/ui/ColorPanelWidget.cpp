#include "ui/ColorPanelWidget.h"

#include <QCheckBox>
#include <QColorDialog>
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QFileDialog>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QPainter>
#include <QPushButton>
#include <QScrollArea>
#include <QSignalBlocker>
#include <QSlider>
#include <QUuid>
#include <QVBoxLayout>

#include <algorithm>
#include <cmath>

#include "core/TimelineModel.h"

namespace catcut {

namespace {

QSlider* makeSlider(int min, int max, int value)
{
    auto* s = new QSlider(Qt::Horizontal);
    s->setRange(min, max);
    s->setValue(value);
    return s;
}

QDoubleSpinBox* makeSpin(double min, double max, double step, int decimals, double value)
{
    auto* s = new QDoubleSpinBox();
    s->setRange(min, max);
    s->setSingleStep(step);
    s->setDecimals(decimals);
    s->setValue(value);
    return s;
}

const char* kWheelNames[4] = {"阴影", "中间调", "高光", "全局"};
const char* kChannelNames[4] = {"主", "R", "G", "B"};
const char* kZoneNames[7] = {"红", "橙", "黄", "绿", "青", "蓝", "品红"};

} // namespace

// ---------------------------------------------------------------- scopes

ScopesWidget::ScopesWidget(QWidget* parent)
    : QWidget(parent)
{
    setMinimumHeight(260);
}

void ScopesWidget::setImage(const QImage& image)
{
    if (image.isNull()) {
        m_hasScopes = false;
        update();
        return;
    }
    m_scopes = ColorScopes::compute(image);
    m_hasScopes = true;
    update();
}

void ScopesWidget::paintEvent(QPaintEvent*)
{
    QPainter p(this);
    p.fillRect(rect(), QColor(24, 24, 28));
    if (!m_hasScopes) {
        p.setPen(Qt::gray);
        p.drawText(rect(), Qt::AlignCenter, QStringLiteral("无画面：导入媒体后显示示波器"));
        return;
    }
    const int w = width(), h = height();
    const int sectionH = h / 3;
    // Histogram (top): RGB overlaid, luma as a white line.
    int histMax = 1;
    for (int i = 0; i < 256; ++i)
        histMax = std::max({histMax, m_scopes.histR[i], m_scopes.histG[i], m_scopes.histB[i]});
    const QColor histColours[3] = {QColor(255, 80, 80, 160), QColor(80, 255, 80, 160),
                                   QColor(80, 120, 255, 160)};
    const int* histData[3] = {m_scopes.histR, m_scopes.histG, m_scopes.histB};
    for (int ch = 0; ch < 3; ++ch) {
        p.setPen(histColours[ch]);
        for (int x = 0; x < 256; ++x) {
            const int px = x * w / 256;
            const int barH = histData[ch][x] * (sectionH - 8) / histMax;
            p.drawLine(px, sectionH - 4, px, sectionH - 4 - barH);
        }
    }
    p.setPen(Qt::white);
    p.drawText(4, 12, QStringLiteral("直方图"));
    // Waveform (middle): per-column min/max luma band.
    p.setPen(QColor(120, 220, 120));
    for (int x = 0; x < 256; ++x) {
        const int px = x * w / 256;
        const int y0 = sectionH + static_cast<int>((1.0f - m_scopes.waveMax[x]) * (sectionH - 8)) + 4;
        const int y1 = sectionH + static_cast<int>((1.0f - m_scopes.waveMin[x]) * (sectionH - 8)) + 4;
        p.drawLine(px, y0, px, y1);
    }
    p.setPen(Qt::white);
    p.drawText(4, sectionH + 12, QStringLiteral("波形"));
    // Vectorscope (bottom): grid counts as green dots, skin-tone line.
    float vecMax = 1.0f;
    for (float v : m_scopes.vectorGrid)
        vecMax = std::max(vecMax, v);
    const int scopeTop = 2 * sectionH;
    const int scopeSize = sectionH - 8;
    const int ox = (w - scopeSize) / 2;
    p.setPen(QColor(90, 90, 100));
    p.drawEllipse(ox, scopeTop + 4, scopeSize, scopeSize);
    p.drawLine(ox + scopeSize / 2, scopeTop + 4, ox + scopeSize / 2, scopeTop + 4 + scopeSize);
    p.drawLine(ox, scopeTop + 4 + scopeSize / 2, ox + scopeSize, scopeTop + 4 + scopeSize / 2);
    for (int gy = 0; gy < 128; ++gy) {
        for (int gx = 0; gx < 128; ++gx) {
            const float v = m_scopes.vectorGrid[static_cast<size_t>(gy * 128 + gx)];
            if (v <= 0.0f)
                continue;
            const int a = static_cast<int>(std::min(255.0f, v / vecMax * 255.0f * 4.0f));
            p.setPen(QColor(120, 220, 120, a));
            p.drawPoint(ox + gx * scopeSize / 128, scopeTop + 4 + gy * scopeSize / 128);
        }
    }
    p.setPen(Qt::white);
    p.drawText(4, scopeTop + 12, QStringLiteral("矢量"));
}

// ---------------------------------------------------------------- panel

ColorPanelWidget::ColorPanelWidget(QWidget* parent)
    : QWidget(parent)
{
    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* scroll = new QScrollArea();
    scroll->setWidgetResizable(true);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    auto* body = new QWidget();
    auto* layout = new QVBoxLayout(body);
    layout->setContentsMargins(4, 4, 4, 4);

    // Reads the selected clip (when any) and hands its grade to `fn`.
    // No clip / no model: silently does nothing.
    auto withClip = [this](auto&& fn) {
        if (m_refreshing || !m_model || m_clipId.isEmpty())
            return;
        Clip* clip = m_model->findClip(m_clipId);
        if (clip)
            fn(clip);
    };
    auto notifyChanged = [this]() { emit changed(); };

    // --- scopes (live, beside the inspector) ---
    {
        auto* group = new QGroupBox(QStringLiteral("示波器（波形 / 矢量 / 直方图）"));
        auto* gl = new QVBoxLayout(group);
        m_scopes = new ScopesWidget();
        gl->addWidget(m_scopes);
        layout->addWidget(group);
    }

    // --- white balance ---
    {
        auto* group = new QGroupBox(QStringLiteral("白平衡"));
        auto* form = new QFormLayout(group);
        m_tempSlider = makeSlider(-100, 100, 0);
        connect(m_tempSlider, &QSlider::valueChanged, this, [withClip, notifyChanged](int v) {
            withClip([v](Clip* c) { c->grade.temperature = v / 100.0; c->gradeEnabled = true; });
            notifyChanged();
        });
        form->addRow(QStringLiteral("色温"), m_tempSlider);
        m_tintSlider = makeSlider(-100, 100, 0);
        connect(m_tintSlider, &QSlider::valueChanged, this, [withClip, notifyChanged](int v) {
            withClip([v](Clip* c) { c->grade.tint = v / 100.0; c->gradeEnabled = true; });
            notifyChanged();
        });
        form->addRow(QStringLiteral("色调"), m_tintSlider);
        layout->addWidget(group);
    }

    // --- colour wheels ---
    {
        auto* group = new QGroupBox(QStringLiteral("色轮（阴影 / 中间调 / 高光 / 全局）"));
        auto* form = new QFormLayout(group);
        const char* channelLabels[3] = {"R", "G", "B"};
        for (int wheel = 0; wheel < 4; ++wheel) {
            auto* row = new QHBoxLayout();
            for (int ch = 0; ch < 3; ++ch) {
                auto* s = makeSlider(-100, 100, 0);
                s->setToolTip(QString::fromLatin1(channelLabels[ch]));
                connect(s, &QSlider::valueChanged, this, [withClip, notifyChanged, wheel, ch](int v) {
                    withClip([v, wheel, ch](Clip* c) {
                        double* target = ch == 0 ? &c->grade.wheels[wheel].r
                            : ch == 1 ? &c->grade.wheels[wheel].g : &c->grade.wheels[wheel].b;
                        *target = v / 100.0;
                        c->gradeEnabled = true;
                    });
                    notifyChanged();
                });
                m_wheelSliders[wheel][ch] = s;
                row->addWidget(s);
            }
            form->addRow(QString::fromUtf8(kWheelNames[wheel]), row);
        }
        layout->addWidget(group);
    }

    // --- curves ---
    {
        auto* group = new QGroupBox(QStringLiteral("RGB / 亮度曲线（5 点，x 固定 0 / .25 / .5 / .75 / 1）"));
        auto* form = new QFormLayout(group);
        for (int ch = 0; ch < 4; ++ch) {
            auto* row = new QHBoxLayout();
            for (int pt = 0; pt < 5; ++pt) {
                auto* s = makeSpin(0.0, 1.0, 0.05, 2, pt / 4.0);
                connect(s, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this,
                        [withClip, notifyChanged, ch, pt](double v) {
                            withClip([v, ch, pt](Clip* c) {
                                c->grade.curves.points[static_cast<size_t>(ch)]
                                                    [static_cast<size_t>(pt)] = v;
                                c->gradeEnabled = true;
                            });
                            notifyChanged();
                        });
                m_curveSpins[ch][pt] = s;
                row->addWidget(s);
            }
            form->addRow(QString::fromUtf8(kChannelNames[ch]), row);
        }
        layout->addWidget(group);
    }

    // --- HSL zones ---
    {
        auto* group = new QGroupBox(QStringLiteral("HSL 七区（色相偏移 / 饱和度 / 明度）"));
        auto* form = new QFormLayout(group);
        for (int zone = 0; zone < 7; ++zone) {
            auto* row = new QHBoxLayout();
            auto* hue = makeSpin(-0.5, 0.5, 0.01, 2, 0.0);
            auto* sat = makeSpin(-1.0, 1.0, 0.05, 2, 0.0);
            auto* light = makeSpin(-1.0, 1.0, 0.05, 2, 0.0);
            auto hook = [this, withClip, notifyChanged, zone](QDoubleSpinBox* spin, int which) {
                connect(spin, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this,
                        [withClip, notifyChanged, zone, which](double v) {
                            withClip([v, zone, which](Clip* c) {
                                HslZone& z = c->grade.hslZones[static_cast<size_t>(zone)];
                                if (which == 0) z.hueShift = v;
                                else if (which == 1) z.saturation = v;
                                else z.lightness = v;
                                c->gradeEnabled = true;
                            });
                            notifyChanged();
                        });
            };
            hook(hue, 0);
            hook(sat, 1);
            hook(light, 2);
            m_hslSpins[zone][0] = hue;
            m_hslSpins[zone][1] = sat;
            m_hslSpins[zone][2] = light;
            row->addWidget(hue);
            row->addWidget(sat);
            row->addWidget(light);
            form->addRow(QString::fromUtf8(kZoneNames[zone]), row);
        }
        layout->addWidget(group);
    }

    // --- LUT ---
    {
        auto* group = new QGroupBox(QStringLiteral("LUT（.cube）"));
        auto* gl = new QVBoxLayout(group);
        m_lutLabel = new QLabel(QStringLiteral("未加载 LUT"));
        gl->addWidget(m_lutLabel);
        auto* row = new QHBoxLayout();
        auto* importButton = new QPushButton(QStringLiteral("导入 .cube…"));
        connect(importButton, &QPushButton::clicked, this, [this, withClip, notifyChanged]() {
            const QString path = QFileDialog::getOpenFileName(
                this, QStringLiteral("导入 LUT"), QString(), QStringLiteral("Cube LUT (*.cube)"));
            if (path.isEmpty() || !m_model || m_clipId.isEmpty())
                return;
            Clip* clip = m_model->findClip(m_clipId);
            if (!clip)
                return;
            QString error;
            CubeLut lut;
            if (!loadCubeLutFile(path, lut, error)) {
                m_lutLabel->setText(QStringLiteral("LUT 加载失败：%1").arg(error));
                return;
            }
            clip->grade.lut = lut;
            clip->grade.lutEnabled = true;
            clip->gradeEnabled = true;
            rebuildLutLabel();
            notifyChanged();
        });
        auto* clearButton = new QPushButton(QStringLiteral("清除"));
        connect(clearButton, &QPushButton::clicked, this, [this, withClip, notifyChanged]() {
            withClip([](Clip* c) {
                c->grade.lutEnabled = false;
                c->grade.lut = CubeLut();
            });
            rebuildLutLabel();
            notifyChanged();
        });
        row->addWidget(importButton);
        row->addWidget(clearButton);
        gl->addLayout(row);
        layout->addWidget(group);
    }

    // --- beauty ---
    {
        auto* group = new QGroupBox(QStringLiteral("美颜（磨皮 + 轻微提亮）"));
        auto* form = new QFormLayout(group);
        m_beautyCheck = new QCheckBox(QStringLiteral("启用美颜"));
        connect(m_beautyCheck, &QCheckBox::toggled, this, [withClip, notifyChanged](bool on) {
            withClip([on](Clip* c) { c->beauty.enabled = on; });
            notifyChanged();
        });
        form->addRow(m_beautyCheck);
        m_beautyStrengthSlider = makeSlider(0, 100, 50);
        connect(m_beautyStrengthSlider, &QSlider::valueChanged, this, [withClip, notifyChanged](int v) {
            withClip([v](Clip* c) { c->beauty.strength = v / 100.0; });
            notifyChanged();
        });
        form->addRow(QStringLiteral("磨皮强度"), m_beautyStrengthSlider);
        m_beautyBrightenSlider = makeSlider(0, 20, 5);
        connect(m_beautyBrightenSlider, &QSlider::valueChanged, this, [withClip, notifyChanged](int v) {
            withClip([v](Clip* c) { c->beauty.brighten = v / 100.0; });
            notifyChanged();
        });
        form->addRow(QStringLiteral("提亮"), m_beautyBrightenSlider);
        auto* note = new QLabel(QStringLiteral(
            "无人像遮罩时整帧轻处理；有遮罩才分区。美颜与人像抠像背景互斥"
            "（两者都要遮罩）；绿幕抠像不受此限。"));
        note->setWordWrap(true);
        form->addRow(note);
        layout->addWidget(group);
    }

    // --- chroma key + mask ---
    {
        auto* group = new QGroupBox(QStringLiteral("抠像与蒙版"));
        auto* form = new QFormLayout(group);
        m_keyCheck = new QCheckBox(QStringLiteral("启用色度键（绿幕）"));
        connect(m_keyCheck, &QCheckBox::toggled, this, [withClip, notifyChanged](bool on) {
            withClip([on](Clip* c) { c->chromaKey.enabled = on; });
            notifyChanged();
        });
        form->addRow(m_keyCheck);
        m_keyColourButton = new QPushButton(QStringLiteral("键色：绿"));
        connect(m_keyColourButton, &QPushButton::clicked, this, [this, withClip, notifyChanged]() {
            if (!m_model || m_clipId.isEmpty())
                return;
            Clip* clip = m_model->findClip(m_clipId);
            if (!clip)
                return;
            const QColor picked = QColorDialog::getColor(
                QColor(static_cast<int>(clip->chromaKey.keyR * 255),
                       static_cast<int>(clip->chromaKey.keyG * 255),
                       static_cast<int>(clip->chromaKey.keyB * 255)),
                this, QStringLiteral("选择键色"));
            if (!picked.isValid())
                return;
            clip->chromaKey.keyR = picked.redF();
            clip->chromaKey.keyG = picked.greenF();
            clip->chromaKey.keyB = picked.blueF();
            m_keyColourButton->setText(QStringLiteral("键色：#%1%2%3")
                .arg(picked.red(), 2, 16, QChar('0'))
                .arg(picked.green(), 2, 16, QChar('0'))
                .arg(picked.blue(), 2, 16, QChar('0')));
            notifyChanged();
        });
        form->addRow(QStringLiteral("键色"), m_keyColourButton);
        m_keyToleranceSlider = makeSlider(0, 100, 25);
        connect(m_keyToleranceSlider, &QSlider::valueChanged, this, [withClip, notifyChanged](int v) {
            withClip([v](Clip* c) { c->chromaKey.tolerance = v / 100.0; });
            notifyChanged();
        });
        form->addRow(QStringLiteral("容差"), m_keyToleranceSlider);
        m_keySoftnessSlider = makeSlider(0, 100, 10);
        connect(m_keySoftnessSlider, &QSlider::valueChanged, this, [withClip, notifyChanged](int v) {
            withClip([v](Clip* c) { c->chromaKey.softness = v / 100.0; });
            notifyChanged();
        });
        form->addRow(QStringLiteral("柔和"), m_keySoftnessSlider);
        m_maskCombo = new QComboBox();
        m_maskCombo->addItem(QStringLiteral("无蒙版"), -1);
        m_maskCombo->addItem(QStringLiteral("矩形"), static_cast<int>(MaskShapeKind::Rectangle));
        m_maskCombo->addItem(QStringLiteral("圆形"), static_cast<int>(MaskShapeKind::Circle));
        m_maskCombo->addItem(QStringLiteral("钢笔路径（多边形）"), static_cast<int>(MaskShapeKind::Polygon));
        connect(m_maskCombo, QOverload<int>::of(&QComboBox::currentIndexChanged), this,
                [withClip, notifyChanged, this](int) {
                    withClip([this](Clip* c) {
                        const int kind = m_maskCombo->currentData().toInt();
                        c->maskEnabled = kind >= 0;
                        if (kind >= 0)
                            c->mask.kind = static_cast<MaskShapeKind>(kind);
                    });
                    notifyChanged();
                });
        form->addRow(QStringLiteral("形状遮罩"), m_maskCombo);
        m_maskFeatherSpin = makeSpin(0.0, 1.0, 0.05, 2, 0.0);
        connect(m_maskFeatherSpin, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this,
                [withClip, notifyChanged](double v) {
                    withClip([v](Clip* c) { c->mask.feather = v; });
                    notifyChanged();
                });
        form->addRow(QStringLiteral("羽化"), m_maskFeatherSpin);
        layout->addWidget(group);
    }

    // --- canvas ---
    {
        auto* group = new QGroupBox(QStringLiteral("画布构图"));
        auto* form = new QFormLayout(group);
        auto* cropRow = new QHBoxLayout();
        const char* cropLabels[4] = {"x", "y", "宽", "高"};
        for (int i = 0; i < 4; ++i) {
            auto* s = makeSpin(0.0, 1.0, 0.05, 2, i < 2 ? 0.0 : 1.0);
            s->setToolTip(QString::fromUtf8(cropLabels[i]));
            connect(s, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this,
                    [this, notifyChanged, i](double v) {
                        if (m_refreshing || !m_model)
                            return;
                        CanvasStyle canvas = m_model->canvasStyle();
                        double* target = i == 0 ? &canvas.crop.x : i == 1 ? &canvas.crop.y
                            : i == 2 ? &canvas.crop.width : &canvas.crop.height;
                        *target = v;
                        m_model->setCanvasStyle(canvas);
                        notifyChanged();
                    });
            m_cropSpins[i] = s;
            cropRow->addWidget(s);
        }
        form->addRow(QStringLiteral("裁切（归一化）"), cropRow);
        m_paddingSlider = makeSlider(0, 25, 0);
        connect(m_paddingSlider, &QSlider::valueChanged, this, [this, notifyChanged](int v) {
            if (m_refreshing || !m_model) return;
            CanvasStyle canvas = m_model->canvasStyle();
            canvas.padding = v / 100.0;
            m_model->setCanvasStyle(canvas);
            notifyChanged();
        });
        form->addRow(QStringLiteral("留白"), m_paddingSlider);
        m_cornerSlider = makeSlider(0, 100, 0);
        connect(m_cornerSlider, &QSlider::valueChanged, this, [this, notifyChanged](int v) {
            if (m_refreshing || !m_model) return;
            CanvasStyle canvas = m_model->canvasStyle();
            canvas.cornerRadius = v;
            m_model->setCanvasStyle(canvas);
            notifyChanged();
        });
        form->addRow(QStringLiteral("圆角"), m_cornerSlider);
        m_strokeSlider = makeSlider(0, 40, 0);
        connect(m_strokeSlider, &QSlider::valueChanged, this, [this, notifyChanged](int v) {
            if (m_refreshing || !m_model) return;
            CanvasStyle canvas = m_model->canvasStyle();
            canvas.strokeWidth = v;
            m_model->setCanvasStyle(canvas);
            notifyChanged();
        });
        form->addRow(QStringLiteral("描边"), m_strokeSlider);
        m_shadowSlider = makeSlider(0, 100, 0);
        connect(m_shadowSlider, &QSlider::valueChanged, this, [this, notifyChanged](int v) {
            if (m_refreshing || !m_model) return;
            CanvasStyle canvas = m_model->canvasStyle();
            canvas.shadowStrength = v / 100.0;
            m_model->setCanvasStyle(canvas);
            notifyChanged();
        });
        form->addRow(QStringLiteral("阴影"), m_shadowSlider);
        m_frameCombo = new QComboBox();
        m_frameCombo->addItem(QStringLiteral("无外框"), QStringLiteral("none"));
        m_frameCombo->addItem(QStringLiteral("浅色窗口"), QStringLiteral("window-light"));
        m_frameCombo->addItem(QStringLiteral("深色窗口"), QStringLiteral("window-dark"));
        m_frameCombo->addItem(QStringLiteral("浅色浏览器"), QStringLiteral("browser-light"));
        m_frameCombo->addItem(QStringLiteral("深色浏览器"), QStringLiteral("browser-dark"));
        m_frameCombo->addItem(QStringLiteral("手机"), QStringLiteral("phone"));
        m_frameCombo->addItem(QStringLiteral("平板"), QStringLiteral("tablet"));
        connect(m_frameCombo, QOverload<int>::of(&QComboBox::currentIndexChanged), this,
                [this, notifyChanged](int) {
                    if (m_refreshing || !m_model) return;
                    CanvasStyle canvas = m_model->canvasStyle();
                    canvas.frame = frameStyleFromName(m_frameCombo->currentData().toString());
                    m_model->setCanvasStyle(canvas);
                    notifyChanged();
                });
        form->addRow(QStringLiteral("样机外框"), m_frameCombo);
        m_frameLandscapeCheck = new QCheckBox(QStringLiteral("横屏"));
        connect(m_frameLandscapeCheck, &QCheckBox::toggled, this, [this, notifyChanged](bool on) {
            if (m_refreshing || !m_model) return;
            CanvasStyle canvas = m_model->canvasStyle();
            canvas.frameLandscape = on;
            m_model->setCanvasStyle(canvas);
            notifyChanged();
        });
        form->addRow(m_frameLandscapeCheck);
        layout->addWidget(group);
    }

    // --- camera motion ---
    {
        auto* group = new QGroupBox(QStringLiteral("运镜（自动缩放 / 屏幕 3D / 光标）"));
        auto* form = new QFormLayout(group);
        m_autoZoomCheck = new QCheckBox(QStringLiteral("自动缩放（按点击分组）"));
        m_autoZoomCheck->setChecked(true);
        connect(m_autoZoomCheck, &QCheckBox::toggled, this, [this, notifyChanged](bool on) {
            if (m_refreshing || !m_model) return;
            m_model->setAutoZoomEnabled(on);
            notifyChanged();
        });
        form->addRow(m_autoZoomCheck);
        m_autoZoomLabel = new QLabel(QStringLiteral("自动缩放片段：0"));
        form->addRow(m_autoZoomLabel);
        m_springStiffnessSpin = makeSpin(1.0, 400.0, 10.0, 0, 120.0);
        connect(m_springStiffnessSpin, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this,
                [this, notifyChanged](double v) {
                    if (m_refreshing || !m_model) return;
                    SpringParams s = m_model->screenSpring();
                    s.stiffness = v;
                    m_model->setScreenSpring(s);
                    notifyChanged();
                });
        form->addRow(QStringLiteral("弹簧刚度"), m_springStiffnessSpin);
        m_springDampingSpin = makeSpin(0.0, 60.0, 1.0, 1, 14.0);
        connect(m_springDampingSpin, QOverload<double>::of(&QDoubleSpinBox::valueChanged), this,
                [this, notifyChanged](double v) {
                    if (m_refreshing || !m_model) return;
                    SpringParams s = m_model->screenSpring();
                    s.damping = v;
                    m_model->setScreenSpring(s);
                    notifyChanged();
                });
        form->addRow(QStringLiteral("弹簧阻尼"), m_springDampingSpin);
        // 3D sliders edit the first screen-motion segment (created on
        // demand, spanning the timeline, from identity to the pose).
        auto make3DSlider = [this, notifyChanged](int min, int max, int value) {
            auto* s = makeSlider(min, max, value);
            connect(s, &QSlider::valueChanged, this, [this, notifyChanged](int) { applyProjectSettings(); });
            return s;
        };
        m_tiltXSlider = make3DSlider(-60, 60, 0);
        form->addRow(QStringLiteral("倾斜 X（°）"), m_tiltXSlider);
        m_tiltYSlider = make3DSlider(-60, 60, 0);
        form->addRow(QStringLiteral("倾斜 Y（°）"), m_tiltYSlider);
        m_rotZSlider = make3DSlider(-180, 180, 0);
        form->addRow(QStringLiteral("旋转 Z（°）"), m_rotZSlider);
        m_perspSlider = make3DSlider(0, 100, 0);
        form->addRow(QStringLiteral("透视"), m_perspSlider);
        m_size3DSlider = make3DSlider(50, 200, 100);
        form->addRow(QStringLiteral("大小（%）"), m_size3DSlider);
        m_zoomFocusCheck = new QCheckBox(QStringLiteral("缩放焦点虚化"));
        connect(m_zoomFocusCheck, &QCheckBox::toggled, this, [this, notifyChanged](bool on) {
            if (m_refreshing || !m_model) return;
            FocusEffect f = m_model->zoomFocus();
            f.enabled = on;
            m_model->setZoomFocus(f);
            notifyChanged();
        });
        form->addRow(m_zoomFocusCheck);
        m_3dFocusCheck = new QCheckBox(QStringLiteral("3D 焦点虚化（与缩放焦点重叠时只用它）"));
        connect(m_3dFocusCheck, &QCheckBox::toggled, this, [this, notifyChanged](bool on) {
            if (m_refreshing || !m_model) return;
            FocusEffect f = m_model->screen3DFocus();
            f.enabled = on;
            m_model->setScreen3DFocus(f);
            notifyChanged();
        });
        form->addRow(m_3dFocusCheck);
        layout->addWidget(group);
    }

    layout->addStretch();
    scroll->setWidget(body);
    outer->addWidget(scroll);
    refresh(QString(), 0.0);
}

void ColorPanelWidget::rebuildLutLabel()
{
    if (!m_model || m_clipId.isEmpty()) {
        m_lutLabel->setText(QStringLiteral("未加载 LUT"));
        return;
    }
    const Clip* clip = m_model->findClip(m_clipId);
    if (!clip || !clip->grade.lutEnabled || !clip->grade.lut.isValid()) {
        m_lutLabel->setText(QStringLiteral("未加载 LUT"));
        return;
    }
    m_lutLabel->setText(QStringLiteral("已加载：%1（%2³）")
                            .arg(clip->grade.lut.sourcePath)
                            .arg(clip->grade.lut.size));
}

void ColorPanelWidget::applyProjectSettings()
{
    if (m_refreshing || !m_model)
        return;
    // 3D sliders -> first screen-motion segment (created on demand).
    ScreenMotionSegment segment;
    bool exists = false;
    if (!m_model->screenMotions().isEmpty()) {
        segment = m_model->screenMotions().first();
        exists = true;
    } else {
        segment.id = QUuid::createUuid().toString();
        segment.start = 0.0;
        segment.moveIn = 0.4;
        segment.hold = std::max(1.0, m_model->totalDuration());
        segment.moveOut = 0.4;
        segment.from = Screen3D();
        segment.to = Screen3D();
    }
    segment.to.tiltX = m_tiltXSlider->value();
    segment.to.tiltY = m_tiltYSlider->value();
    segment.to.rotationZ = m_rotZSlider->value();
    segment.to.perspective = m_perspSlider->value() / 100.0;
    segment.to.size = m_size3DSlider->value() / 100.0;
    if (exists) {
        // Replace in place: remove + re-add keeps the list order.
        m_model->removeScreenMotion(segment.id);
        m_model->addScreenMotion(segment);
    } else {
        m_model->addScreenMotion(segment);
    }
    emit changed();
}

void ColorPanelWidget::refresh(const QString& clipId, double playheadSeconds)
{
    m_clipId = clipId;
    m_playhead = playheadSeconds;
    m_refreshing = true;
    const Clip* clip = m_model ? m_model->findClip(clipId) : nullptr;
    const bool hasClip = clip != nullptr;

    auto setSlider = [](QSlider* s, int v) {
        const QSignalBlocker b(s);
        s->setValue(v);
    };
    auto setSpin = [](QDoubleSpinBox* s, double v) {
        const QSignalBlocker b(s);
        s->setValue(v);
    };

    // Clip sections.
    const ColorGrade& grade = hasClip ? clip->grade : ColorGrade();
    setSlider(m_tempSlider, static_cast<int>(grade.temperature * 100.0));
    setSlider(m_tintSlider, static_cast<int>(grade.tint * 100.0));
    for (int wheel = 0; wheel < 4; ++wheel) {
        const ColorWheel& w = grade.wheels[wheel];
        setSlider(m_wheelSliders[wheel][0], static_cast<int>(w.r * 100.0));
        setSlider(m_wheelSliders[wheel][1], static_cast<int>(w.g * 100.0));
        setSlider(m_wheelSliders[wheel][2], static_cast<int>(w.b * 100.0));
    }
    for (int ch = 0; ch < 4; ++ch) {
        for (int pt = 0; pt < 5; ++pt)
            setSpin(m_curveSpins[ch][pt], grade.curves.points[static_cast<size_t>(ch)][static_cast<size_t>(pt)]);
    }
    for (int zone = 0; zone < 7; ++zone) {
        const HslZone& z = grade.hslZones[static_cast<size_t>(zone)];
        setSpin(m_hslSpins[zone][0], z.hueShift);
        setSpin(m_hslSpins[zone][1], z.saturation);
        setSpin(m_hslSpins[zone][2], z.lightness);
    }
    rebuildLutLabel();
    {
        const QSignalBlocker b(m_beautyCheck);
        m_beautyCheck->setChecked(hasClip && clip->beauty.enabled);
    }
    setSlider(m_beautyStrengthSlider, hasClip ? static_cast<int>(clip->beauty.strength * 100.0) : 50);
    setSlider(m_beautyBrightenSlider, hasClip ? static_cast<int>(clip->beauty.brighten * 100.0) : 5);
    {
        const QSignalBlocker b(m_keyCheck);
        m_keyCheck->setChecked(hasClip && clip->chromaKey.enabled);
    }
    setSlider(m_keyToleranceSlider, hasClip ? static_cast<int>(clip->chromaKey.tolerance * 100.0) : 25);
    setSlider(m_keySoftnessSlider, hasClip ? static_cast<int>(clip->chromaKey.softness * 100.0) : 10);
    {
        const QSignalBlocker b(m_maskCombo);
        m_maskCombo->setCurrentIndex(hasClip && clip->maskEnabled
            ? m_maskCombo->findData(static_cast<int>(clip->mask.kind)) : 0);
    }
    setSpin(m_maskFeatherSpin, hasClip ? clip->mask.feather : 0.0);

    // Project sections.
    if (m_model) {
        const CanvasStyle& canvas = m_model->canvasStyle();
        setSpin(m_cropSpins[0], canvas.crop.x);
        setSpin(m_cropSpins[1], canvas.crop.y);
        setSpin(m_cropSpins[2], canvas.crop.width);
        setSpin(m_cropSpins[3], canvas.crop.height);
        setSlider(m_paddingSlider, static_cast<int>(canvas.padding * 100.0));
        setSlider(m_cornerSlider, static_cast<int>(canvas.cornerRadius));
        setSlider(m_strokeSlider, static_cast<int>(canvas.strokeWidth));
        setSlider(m_shadowSlider, static_cast<int>(canvas.shadowStrength * 100.0));
        {
            const QSignalBlocker b(m_frameCombo);
            m_frameCombo->setCurrentIndex(
                m_frameCombo->findData(frameStyleName(canvas.frame)));
        }
        {
            const QSignalBlocker b(m_frameLandscapeCheck);
            m_frameLandscapeCheck->setChecked(canvas.frameLandscape);
        }
        {
            const QSignalBlocker b(m_autoZoomCheck);
            m_autoZoomCheck->setChecked(m_model->autoZoomEnabled());
        }
        m_autoZoomLabel->setText(QStringLiteral("自动缩放片段：%1（点击 %2 个）")
            .arg(m_model->plannedAutoZoom().size())
            .arg(m_model->clickEvents().size()));
        setSpin(m_springStiffnessSpin, m_model->screenSpring().stiffness);
        setSpin(m_springDampingSpin, m_model->screenSpring().damping);
        Screen3D pose;
        if (!m_model->screenMotions().isEmpty())
            pose = m_model->screenMotions().first().to;
        setSlider(m_tiltXSlider, static_cast<int>(pose.tiltX));
        setSlider(m_tiltYSlider, static_cast<int>(pose.tiltY));
        setSlider(m_rotZSlider, static_cast<int>(pose.rotationZ));
        setSlider(m_perspSlider, static_cast<int>(pose.perspective * 100.0));
        setSlider(m_size3DSlider, static_cast<int>(pose.size * 100.0));
        {
            const QSignalBlocker b(m_zoomFocusCheck);
            m_zoomFocusCheck->setChecked(m_model->zoomFocus().enabled);
        }
        {
            const QSignalBlocker b(m_3dFocusCheck);
            m_3dFocusCheck->setChecked(m_model->screen3DFocus().enabled);
        }
    }

    // Enable/disable clip sections when nothing is selected.
    const bool clipEnabled = hasClip;
    for (QSlider* s : {m_tempSlider, m_tintSlider, m_beautyStrengthSlider,
                       m_beautyBrightenSlider, m_keyToleranceSlider, m_keySoftnessSlider})
        s->setEnabled(clipEnabled);
    for (int wheel = 0; wheel < 4; ++wheel) {
        for (int ch = 0; ch < 3; ++ch)
            m_wheelSliders[wheel][ch]->setEnabled(clipEnabled);
    }
    for (int ch = 0; ch < 4; ++ch) {
        for (int pt = 0; pt < 5; ++pt)
            m_curveSpins[ch][pt]->setEnabled(clipEnabled);
    }
    for (int zone = 0; zone < 7; ++zone) {
        for (int k = 0; k < 3; ++k)
            m_hslSpins[zone][k]->setEnabled(clipEnabled);
    }
    m_maskFeatherSpin->setEnabled(clipEnabled);
    m_beautyCheck->setEnabled(clipEnabled);
    m_keyCheck->setEnabled(clipEnabled);
    m_keyColourButton->setEnabled(clipEnabled);
    m_maskCombo->setEnabled(clipEnabled);
    m_lutLabel->setEnabled(clipEnabled);

    m_refreshing = false;
}

void ColorPanelWidget::setScopesImage(const QImage& image)
{
    if (m_scopes)
        m_scopes->setImage(image);
}

} // namespace catcut
