#include "ui/MainWindow.h"

#include "core/ProjectModel.h"
#include "media/MediaProbe.h"
#include "media/PreviewRenderer.h"
#include "media/ProxyJob.h"
#include "ui/PreviewWidget.h"

#include <QApplication>
#include <QCloseEvent>
#include <QCryptographicHash>
#include <QDir>
#include <QDockWidget>
#include <QFileDialog>
#include <QFileInfo>
#include <QHeaderView>
#include <QLabel>
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QMetaObject>
#include <QPointer>
#include <QPushButton>
#include <QSettings>
#include <QStandardPaths>
#include <QStatusBar>
#include <QTableWidget>
#include <QVBoxLayout>
#include <QWidget>

namespace catcut {

namespace {

QLabel* placeholderLabel(const QString& text, bool dark = false)
{
    auto* label = new QLabel(text);
    label->setAlignment(Qt::AlignCenter);
    label->setWordWrap(true);
    if (dark)
        label->setStyleSheet(QStringLiteral("background-color: black; color: #888888;"));
    return label;
}

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
        layout->addWidget(m_mediaTable);
        m_mediaDock->setWidget(mediaWidget);
    }
    m_mediaDock->setObjectName(QStringLiteral("dockMedia"));

    // --- Preview (S1): real first-frame rendering via PreviewWidget. ---
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

    m_timelineDock = makeDock(QStringLiteral("时间线"));
    m_timelineDock->setWidget(placeholderLabel(QStringLiteral("时间线\n（S2 接入时间线编辑）")));
    m_timelineDock->setObjectName(QStringLiteral("dockTimeline"));

    m_inspectorDock = makeDock(QStringLiteral("检查器"));
    m_inspectorDock->setWidget(placeholderLabel(QStringLiteral("检查器\n未选中任何片段")));
    m_inspectorDock->setObjectName(QStringLiteral("dockInspector"));
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
    for (QDockWidget* dock : {m_mediaDock, m_previewDock, m_timelineDock, m_inspectorDock}) {
        dock->setFloating(false);
        dock->show();
        removeDockWidget(dock);
    }
    addDockWidget(Qt::LeftDockWidgetArea, m_mediaDock);
    addDockWidget(Qt::RightDockWidgetArea, m_inspectorDock);
    addDockWidget(Qt::BottomDockWidgetArea, m_timelineDock);
    splitDockWidget(m_mediaDock, m_previewDock, Qt::Horizontal);
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
    updateWindowTitle();
    statusBar()->showMessage(QStringLiteral("已打开 %1").arg(path), 3000);
    return true;
}

void MainWindow::onNewProject()
{
    m_project = std::make_unique<ProjectModel>();
    m_projectPath.clear();
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

void MainWindow::closeEvent(QCloseEvent* event)
{
    saveWorkspace();
    QMainWindow::closeEvent(event);
}

}
