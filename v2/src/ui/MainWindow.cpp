#include "ui/MainWindow.h"

#include "core/ProjectModel.h"
#include "core/TimelineEvaluator.h"
#include "core/TimelineFrameRenderer.h"
#include "media/Decoder.h"
#include "media/MediaProbe.h"
#include "media/PreviewRenderer.h"
#include "media/ProxyJob.h"
#include "ui/ColorPanelWidget.h"
#include "ui/InspectorWidget.h"
#include "ui/KeyframeChartWidget.h"
#include "ui/PreviewWidget.h"
#include "ui/TimelineWidget.h"

#include <QApplication>
#include <QCloseEvent>
#include <QComboBox>
#include <QCryptographicHash>
#include <QDir>
#include <QDockWidget>
#include <QDrag>
#include <QFileDialog>
#include <QFileInfo>
#include <QHeaderView>
#include <QLabel>
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QMetaObject>
#include <QMimeData>
#include <QMouseEvent>
#include <QPointer>
#include <QPushButton>
#include <QScrollArea>
#include <QSettings>
#include <QStandardPaths>
#include <QStatusBar>
#include <QTableWidget>
#include <QVBoxLayout>
#include <QWidget>

namespace catcut {

namespace {

QDockWidget* makeDock(const QString& title)
{
    auto* dock = new QDockWidget(title);
    dock->setAllowedAreas(Qt::AllDockWidgetAreas);
    dock->setFeatures(QDockWidget::DockWidgetMovable | QDockWidget::DockWidgetFloatable
                      | QDockWidget::DockWidgetClosable);
    return dock;
}

// Cache location for generated proxies: <cache>/catcut/proxies/<sha1>.mp4
QString proxyPathFor(const QString& sourcePath)
{
    const QString dir = QStandardPaths::writableLocation(QStandardPaths::CacheLocation)
        + QStringLiteral("/catcut/proxies");
    QDir().mkpath(dir);
    const QString hash = QString::fromLatin1(
        QCryptographicHash::hash(sourcePath.toUtf8(), QCryptographicHash::Sha1).toHex());
    return dir + QStringLiteral("/") + hash + QStringLiteral(".mp4");
}

} // namespace

MainWindow::MainWindow(QWidget* parent)
    : QMainWindow(parent)
    , m_project(std::make_unique<ProjectModel>())
{
    resize(1280, 800);

    // Dummy central widget: all four panels are docks, so the centre takes
    // no space. Hidden + ignored size policy lets the docks fill the window.
    auto* central = new QWidget(this);
    central->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Ignored);
    central->setMinimumSize(0, 0);
    setCentralWidget(central);
    central->hide();

    setDockOptions(QMainWindow::AllowNestedDocks | QMainWindow::AllowTabbedDocks
                   | QMainWindow::AnimatedDocks);
    setTabPosition(Qt::AllDockWidgetAreas, QTabWidget::North);

    setupDocks();
    setupMenus();
    statusBar()->showMessage(QStringLiteral("就绪"));

    applyDefaultLayout();
    restoreWorkspace();
    updateWindowTitle();
}

MainWindow::~MainWindow() = default;

void MainWindow::setupDocks()
{
    // --- Media library (S1): import button + table with proxy status. ---
    m_mediaDock = makeDock(QStringLiteral("素材库"));
    {
        auto* mediaWidget = new QWidget();
        auto* layout = new QVBoxLayout(mediaWidget);
        layout->setContentsMargins(4, 4, 4, 4);
        auto* importButton = new QPushButton(QStringLiteral("导入媒体…"));
        connect(importButton, &QPushButton::clicked, this, &MainWindow::onImportMedia);
        layout->addWidget(importButton);
        m_mediaTable = new QTableWidget(0, 4);
        m_mediaTable->setHorizontalHeaderLabels(
            { QStringLiteral("文件"), QStringLiteral("分辨率"),
              QStringLiteral("时长"), QStringLiteral("代理状态") });
        m_mediaTable->horizontalHeader()->setStretchLastSection(true);
        m_mediaTable->setSelectionBehavior(QAbstractItemView::SelectRows);
        m_mediaTable->setEditTriggers(QAbstractItemView::NoEditTriggers);
        m_mediaTable->viewport()->installEventFilter(this);
        layout->addWidget(m_mediaTable);
        m_mediaDock->setWidget(mediaWidget);
    }
    m_mediaDock->setObjectName(QStringLiteral("dockMedia"));

    // --- Preview (S1 first frame; S2 timeline frame at the playhead). ---
    m_previewDock = makeDock(QStringLiteral("预览"));
    {
        auto* previewWidget = new QWidget();
        auto* layout = new QVBoxLayout(previewWidget);
        layout->setContentsMargins(0, 0, 0, 0);
        m_previewWidget = new PreviewWidget();
        layout->addWidget(m_previewWidget, 1);
        m_previewStatus = new QLabel(QStringLiteral("未导入媒体"));
        m_previewStatus->setAlignment(Qt::AlignCenter);
        layout->addWidget(m_previewStatus);
        m_previewDock->setWidget(previewWidget);
    }
    m_previewDock->setObjectName(QStringLiteral("dockPreview"));

    // --- Timeline (S2): real timeline widget, replacing the S1 placeholder. ---
    m_timelineDock = makeDock(QStringLiteral("时间线"));
    {
        m_timelineWidget = new TimelineWidget();
        auto* timelineWidget = new QWidget();
        auto* layout = new QVBoxLayout(timelineWidget);
        layout->setContentsMargins(0, 0, 0, 0);
        layout->addWidget(m_timelineWidget->createToolbar());
        auto* scroll = new QScrollArea();
        scroll->setWidget(m_timelineWidget);
        scroll->setWidgetResizable(false);
        layout->addWidget(scroll, 1);
        m_timelineDock->setWidget(timelineWidget);
        connect(m_timelineWidget, &TimelineWidget::playheadChanged,
                this, &MainWindow::onPlayheadChanged);
        connect(m_timelineWidget, &TimelineWidget::modelChanged,
                this, &MainWindow::onTimelineChanged);
        connect(m_timelineWidget, &TimelineWidget::selectionChanged,
                this, &MainWindow::onTimelineSelectionChanged);
    }
    m_timelineDock->setObjectName(QStringLiteral("dockTimeline"));

    // --- Inspector (S2): clip/transition inspector + keyframe chart. ---
    m_inspectorDock = makeDock(QStringLiteral("检查器"));
    {
        auto* inspectorWidget = new QWidget();
        auto* layout = new QVBoxLayout(inspectorWidget);
        layout->setContentsMargins(0, 0, 0, 0);
        m_inspectorWidget = new InspectorWidget();
        m_inspectorWidget->setModel(m_timelineWidget->model());
        connect(m_inspectorWidget, &InspectorWidget::changed,
                this, &MainWindow::onTimelineChanged);
        layout->addWidget(m_inspectorWidget);
        auto* chartLabel = new QLabel(QStringLiteral("关键帧曲线"));
        layout->addWidget(chartLabel);
        auto* paramCombo = new QComboBox();
        for (const QString& name : KeyframeChartWidget::parameterNames())
            paramCombo->addItem(KeyframeChartWidget::parameterDisplayName(name), name);
        layout->addWidget(paramCombo);
        m_chartWidget = new KeyframeChartWidget();
        m_chartWidget->setModel(m_timelineWidget->model());
        connect(paramCombo, &QComboBox::currentIndexChanged, this, [this, paramCombo]() {
            m_chartWidget->setParameter(paramCombo->currentData().toString());
        });
        connect(m_chartWidget, &KeyframeChartWidget::keyframesChanged,
                this, &MainWindow::onTimelineChanged);
        layout->addWidget(m_chartWidget, 1);
        m_inspectorDock->setWidget(inspectorWidget);
    }
    m_inspectorDock->setObjectName(QStringLiteral("dockInspector"));

    // --- Colour (S3): the same ColorPanelWidget as the inspector's
    // "调色" tab, as its own detachable dock (left, tabbed with the
    // media library — architecture doc section 6: colour on the left).
    m_colorDock = makeDock(QStringLiteral("调色"));
    {
        m_colorPanel = new ColorPanelWidget();
        m_colorPanel->setModel(m_timelineWidget->model());
        connect(m_colorPanel, &ColorPanelWidget::changed,
                this, &MainWindow::onTimelineChanged);
        m_colorDock->setWidget(m_colorPanel);
    }
    m_colorDock->setObjectName(QStringLiteral("dockColor"));
}

void MainWindow::setupMenus()
{
    QMenu* fileMenu = menuBar()->addMenu(QStringLiteral("文件"));
    QAction* newAction = fileMenu->addAction(QStringLiteral("新建工程"), this, &MainWindow::onNewProject);
    newAction->setShortcut(QKeySequence::New);
    QAction* openAction = fileMenu->addAction(QStringLiteral("打开工程…"), this, &MainWindow::onOpenProject);
    openAction->setShortcut(QKeySequence::Open);
    QAction* saveAction = fileMenu->addAction(QStringLiteral("保存工程"), this, &MainWindow::onSaveProject);
    saveAction->setShortcut(QKeySequence::Save);
    QAction* saveAsAction = fileMenu->addAction(QStringLiteral("工程另存为…"), this, &MainWindow::onSaveProjectAs);
    saveAsAction->setShortcut(QKeySequence::SaveAs);
    fileMenu->addSeparator();
    QAction* importAction = fileMenu->addAction(QStringLiteral("导入媒体…"), this, &MainWindow::onImportMedia);
    importAction->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_I));
    fileMenu->addSeparator();
    QAction* quitAction = fileMenu->addAction(QStringLiteral("退出"), this, &QWidget::close);
    quitAction->setShortcut(QKeySequence::Quit);

    QMenu* workspaceMenu = menuBar()->addMenu(QStringLiteral("工作区"));
    workspaceMenu->addAction(QStringLiteral("保存工作区"), this, &MainWindow::onSaveWorkspace);
    workspaceMenu->addAction(QStringLiteral("恢复默认布局"), this, &MainWindow::onRestoreDefaultLayout);
}

void MainWindow::applyDefaultLayout()
{
    // Default layout (architecture doc section 6):
    // preview centre-top, timeline bottom, inspector right, media left.
    // S3: the colour dock tabs with the media library on the left.
    for (QDockWidget* dock : {m_mediaDock, m_previewDock, m_timelineDock, m_inspectorDock, m_colorDock}) {
        dock->setFloating(false);
        dock->show();
        removeDockWidget(dock);
    }
    addDockWidget(Qt::LeftDockWidgetArea, m_mediaDock);
    addDockWidget(Qt::RightDockWidgetArea, m_inspectorDock);
    addDockWidget(Qt::BottomDockWidgetArea, m_timelineDock);
    splitDockWidget(m_mediaDock, m_previewDock, Qt::Horizontal);
    addDockWidget(Qt::LeftDockWidgetArea, m_colorDock);
    tabifyDockWidget(m_mediaDock, m_colorDock);
    resizeDocks({m_mediaDock, m_previewDock, m_inspectorDock}, {260, 680, 300}, Qt::Horizontal);
    resizeDocks({m_previewDock, m_timelineDock}, {520, 200}, Qt::Vertical);
}

void MainWindow::restoreWorkspace()
{
    QSettings settings;
    const QByteArray geometry = settings.value(QStringLiteral("workspace/geometry")).toByteArray();
    if (!geometry.isEmpty())
        restoreGeometry(geometry);
    const QByteArray state = settings.value(QStringLiteral("workspace/state")).toByteArray();
    if (!state.isEmpty())
        restoreState(state);
}

void MainWindow::saveWorkspace() const
{
    QSettings settings;
    settings.setValue(QStringLiteral("workspace/geometry"), saveGeometry());
    settings.setValue(QStringLiteral("workspace/state"), saveState());
}

void MainWindow::onSaveWorkspace()
{
    saveWorkspace();
    statusBar()->showMessage(QStringLiteral("工作区已保存"), 3000);
}

void MainWindow::onRestoreDefaultLayout()
{
    QSettings settings;
    settings.remove(QStringLiteral("workspace/geometry"));
    settings.remove(QStringLiteral("workspace/state"));
    applyDefaultLayout();
    statusBar()->showMessage(QStringLiteral("已恢复默认布局"), 3000);
}

void MainWindow::updateWindowTitle()
{
    QString title = QStringLiteral("CatCut v2 — %1").arg(m_project->displayTitle());
    if (!m_projectPath.isEmpty())
        title += QStringLiteral(" — %1").arg(m_projectPath);
    setWindowTitle(title);
}

bool MainWindow::openProject(const QString& path)
{
    QString error;
    auto fresh = std::make_unique<ProjectModel>();
    if (!fresh->loadFromFile(path, error)) {
        QMessageBox::critical(this, QStringLiteral("打不开工程"), error);
        return false;
    }
    m_project = std::move(fresh);
    m_projectPath = path;
    // S2: restore the timeline (empty for S0/S1 projects).
    QString timelineError;
    if (!m_timelineWidget->model()->fromJson(m_project->timelineJson(), timelineError)) {
        QMessageBox::warning(this, QStringLiteral("时间线恢复失败"), timelineError);
    }
    m_timelineWidget->setPlayhead(0.0);
    refreshInspector();
    updateWindowTitle();
    statusBar()->showMessage(QStringLiteral("已打开 %1").arg(path), 3000);
    return true;
}

void MainWindow::onNewProject()
{
    m_project = std::make_unique<ProjectModel>();
    m_projectPath.clear();
    QString error;
    m_timelineWidget->model()->fromJson(QJsonObject(), error);
    m_timelineWidget->setPlayhead(0.0);
    refreshInspector();
    updateWindowTitle();
    statusBar()->showMessage(QStringLiteral("已新建工程"), 3000);
}

void MainWindow::onOpenProject()
{
    const QString path = QFileDialog::getOpenFileName(
        this, QStringLiteral("打开工程"), QString(),
        QStringLiteral("CatCut 工程 (*.catcut);;所有文件 (*)"));
    if (!path.isEmpty())
        openProject(path);
}

void MainWindow::onSaveProject()
{
    if (m_projectPath.isEmpty()) {
        onSaveProjectAs();
        return;
    }
    // S2: persist the timeline into the project before saving.
    m_project->setTimelineJson(m_timelineWidget->model()->toJson());
    QString error;
    if (!m_project->saveToFile(m_projectPath, error)) {
        QMessageBox::critical(this, QStringLiteral("保存失败"), error);
        return;
    }
    updateWindowTitle();
    statusBar()->showMessage(QStringLiteral("已保存 %1").arg(m_projectPath), 3000);
}

void MainWindow::onSaveProjectAs()
{
    const QString path = QFileDialog::getSaveFileName(
        this, QStringLiteral("工程另存为"), QStringLiteral("未命名工程.catcut"),
        QStringLiteral("CatCut 工程 (*.catcut);;所有文件 (*)"));
    if (path.isEmpty())
        return;
    m_projectPath = path;
    onSaveProject();
}

void MainWindow::onImportMedia()
{
    const QString path = QFileDialog::getOpenFileName(
        this, QStringLiteral("导入媒体"), QString(),
        QStringLiteral("视频 (*.mp4 *.mov *.mkv *.webm *.avi *.m4v *.mpg *.mpeg *.wmv);;所有文件 (*)"));
    if (path.isEmpty())
        return;

    const MediaInfo info = MediaProbe::probe(path);
    if (!info.ok) {
        QMessageBox::warning(this, QStringLiteral("无法导入"), info.error);
        return;
    }
    if (!info.hasVideo) {
        QMessageBox::warning(this, QStringLiteral("无法导入"),
                             QStringLiteral("该文件没有视频轨，无法作为视频素材导入。"));
        return;
    }

    const int row = m_mediaTable->rowCount();
    m_mediaTable->insertRow(row);
    m_mediaTable->setItem(row, 0, new QTableWidgetItem(QFileInfo(path).fileName()));
    m_mediaTable->setItem(row, 1, new QTableWidgetItem(
        QStringLiteral("%1x%2").arg(info.width).arg(info.height)));
    m_mediaTable->setItem(row, 2, new QTableWidgetItem(
        info.durationSeconds > 0.0
            ? QStringLiteral("%1s").arg(info.durationSeconds, 0, 'f', 1)
            : QStringLiteral("未知")));
    m_mediaTable->setItem(row, 3, new QTableWidgetItem(QStringLiteral("生成中…")));

    ImportedMedia media;
    media.path = path;
    media.proxyPath = proxyPathFor(path);
    media.proxyJob = std::make_shared<ProxyJob>();
    m_media.append(media);

    // First frame into the preview panel (decoded from the original;
    // timeline playback in S2 will use the proxy, not the original).
    QImage firstFrame;
    QString previewError;
    QString decodePath;
    const QSize previewSize = m_previewWidget->size().isEmpty()
        ? QSize(960, 540) : m_previewWidget->size();
    if (PreviewRenderer::renderFirstFrame(path, firstFrame, previewSize, previewError, decodePath)) {
        m_previewWidget->setImage(firstFrame);
        m_previewStatus->setText(
            QStringLiteral("首帧已渲染（%1解码）").arg(decodePath == QLatin1String("d3d11va")
                ? QStringLiteral("硬件") : QStringLiteral("软件")));
    } else {
        m_previewStatus->setText(QStringLiteral("首帧渲染失败：%1").arg(previewError));
    }

    // Background 720p proxy. The finished callback runs on the worker
    // thread, so hop to the GUI thread before touching the table.
    QPointer<MainWindow> guard(this);
    const int jobRow = row;
    media.proxyJob->startAsync(
        path, media.proxyPath, 720,
        [guard, jobRow](bool ok, const QString& error, const QString& encoderUsed) {
            QMetaObject::invokeMethod(qApp, [guard, jobRow, ok, error, encoderUsed]() {
                if (guard)
                    guard->onProxyFinished(jobRow, ok, error, encoderUsed);
            });
        });
    statusBar()->showMessage(QStringLiteral("已导入 %1，正在生成代理…").arg(QFileInfo(path).fileName()), 3000);
}

void MainWindow::onProxyFinished(int row, bool ok, const QString& error, const QString& encoderUsed)
{
    if (row < 0 || row >= m_mediaTable->rowCount())
        return;
    // A missing/failed proxy is a hard error: show it plainly, never
    // silently fall back to the original for playback.
    m_mediaTable->setItem(row, 3, new QTableWidgetItem(
        ok ? QStringLiteral("已就绪（%1）").arg(encoderUsed)
           : QStringLiteral("失败：%1").arg(error)));
    if (!ok)
        statusBar()->showMessage(QStringLiteral("代理生成失败：%1").arg(error), 5000);
}

// ------------------------------------------------------------- S2 timeline

void MainWindow::onTimelineChanged()
{
    refreshInspector();
    renderPreviewAtPlayhead();
}

void MainWindow::onTimelineSelectionChanged()
{
    refreshInspector();
}

void MainWindow::onPlayheadChanged(double /*seconds*/)
{
    refreshInspector();
    renderPreviewAtPlayhead();
}

void MainWindow::refreshInspector()
{
    if (!m_inspectorWidget || !m_timelineWidget)
        return;
    m_inspectorWidget->refresh(m_timelineWidget->selectedClipId(),
                               m_timelineWidget->selectedTransitionLeftId(),
                               m_timelineWidget->playhead());
    if (m_colorPanel)
        m_colorPanel->refresh(m_timelineWidget->selectedClipId(),
                              m_timelineWidget->playhead());
    if (m_chartWidget)
        m_chartWidget->setClip(m_timelineWidget->selectedClipId());
}

void MainWindow::renderPreviewAtPlayhead()
{
    TimelineModel* timelineModel = m_timelineWidget->model();
    if (!timelineModel || timelineModel->isEmpty())
        return;
    TimelineEvaluator evaluator(timelineModel, QSize(m_project->canvasWidth(), m_project->canvasHeight()));
    const FrameScene scene = evaluator.evaluate(m_timelineWidget->playhead());
    if (scene.videoLayers.isEmpty())
        return;
    TimelineFrameProvider provider = [](const QString& path, double sourceTime, QImage& out) {
        QString error;
        Decoder decoder;
        return decoder.decodeFrameAt(path, sourceTime, QSize(960, 540), out, error);
    };
    // S3 GPU grade: when the scene is a single graded video layer and
    // nothing else needs the CPU picture path (beauty, keying, mask,
    // mosaic, focus), the composite is rendered WITHOUT the grade and
    // the PreviewWidget applies that grade on the GPU (grade.frag).
    // Every other scene renders graded on the CPU, as before. Either
    // way the math and the order are the same (ColorGrade).
    const FrameLayer* gradedLayer = nullptr;
    bool gpuEligible = scene.activeMosaics.isEmpty()
        && scene.focusSource == FocusSource::None;
    int videoLayers = 0;
    for (const FrameLayer& layer : scene.videoLayers) {
        if (layer.kind == ClipKind::Title)
            continue;
        ++videoLayers;
        if (layer.beauty.enabled || layer.chromaKey.enabled || layer.hasMask)
            gpuEligible = false;
        if (layer.hasGrade && !layer.grade.isIdentity()) {
            if (gradedLayer)
                gpuEligible = false; // two graded layers: CPU path
            gradedLayer = &layer;
        }
    }
    if (videoLayers != 1)
        gpuEligible = false;
    QImage image;
    QString error;
    if (gpuEligible && gradedLayer) {
        if (!TimelineFrameRenderer::render(scene, provider, image, error, QSize(960, 540),
                                           false)) {
            m_previewStatus->setText(QStringLiteral("预览渲染失败：%1").arg(error));
            return;
        }
        m_previewWidget->setGradedImage(image, gradedLayer->grade);
    } else {
        if (!TimelineFrameRenderer::render(scene, provider, image, error, QSize(960, 540))) {
            m_previewStatus->setText(QStringLiteral("预览渲染失败：%1").arg(error));
            return;
        }
        m_previewWidget->setImage(image);
    }
    // Scopes: always from a small CPU-graded render (analysis only —
    // the scopes never grade the picture themselves).
    {
        QImage scopesImage;
        QString scopesError;
        if (TimelineFrameRenderer::render(scene, provider, scopesImage, scopesError,
                                          QSize(320, 180))) {
            m_inspectorWidget->setScopesImage(scopesImage);
            if (m_colorPanel)
                m_colorPanel->setScopesImage(scopesImage);
        }
    }
    m_previewStatus->setText(
        QStringLiteral("播放头 %1s / 共 %2s%3")
            .arg(m_timelineWidget->playhead(), 0, 'f', 2)
            .arg(timelineModel->totalDuration(), 0, 'f', 1)
            .arg(scene.hasTransition ? QStringLiteral("（转场中）") : QString()));
}

bool MainWindow::eventFilter(QObject* watched, QEvent* event)
{
    if (watched == m_mediaTable->viewport()) {
        if (event->type() == QEvent::MouseButtonPress) {
            auto* mouseEvent = static_cast<QMouseEvent*>(event);
            m_mediaDragStart = mouseEvent->pos();
            m_mediaDragRow = m_mediaTable->rowAt(mouseEvent->pos().y());
            return false;
        }
        if (event->type() == QEvent::MouseMove) {
            auto* mouseEvent = static_cast<QMouseEvent*>(event);
            if (m_mediaDragRow >= 0 && m_mediaDragRow < m_media.size()
                && (mouseEvent->buttons() & Qt::LeftButton)
                && (mouseEvent->pos() - m_mediaDragStart).manhattanLength()
                    > QApplication::startDragDistance()) {
                auto* drag = new QDrag(m_mediaTable->viewport());
                auto* mime = new QMimeData();
                mime->setData(QStringLiteral("application/x-catcut-media-path"),
                              m_media[m_mediaDragRow].path.toUtf8());
                mime->setText(m_media[m_mediaDragRow].path);
                drag->setMimeData(mime);
                drag->exec(Qt::CopyAction);
                m_mediaDragRow = -1;
                return true;
            }
            return false;
        }
    }
    return QMainWindow::eventFilter(watched, event);
}

void MainWindow::closeEvent(QCloseEvent* event)
{
    saveWorkspace();
    QMainWindow::closeEvent(event);
}

}
