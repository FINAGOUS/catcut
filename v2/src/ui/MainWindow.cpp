#include "ui/MainWindow.h"

#include "core/ProjectModel.h"

#include <QCloseEvent>
#include <QDockWidget>
#include <QFileDialog>
#include <QLabel>
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QSettings>
#include <QStatusBar>
#include <QVBoxLayout>
#include <QWidget>

namespace catcut {

namespace {

// Placeholder label used for the S0 skeleton panels.
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
    m_mediaDock = makeDock(QStringLiteral("素材库"));
    m_mediaDock->setWidget(placeholderLabel(QStringLiteral("素材库\n（S1 接入媒体管线）")));
    m_mediaDock->setObjectName(QStringLiteral("dockMedia"));

    m_previewDock = makeDock(QStringLiteral("预览"));
    m_previewDock->setWidget(placeholderLabel(QStringLiteral("预览区"), true));
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

void MainWindow::closeEvent(QCloseEvent* event)
{
    saveWorkspace();
    QMainWindow::closeEvent(event);
}

}
