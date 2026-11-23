#pragma once

#include <QMainWindow>
#include <QString>
#include <memory>

class QDockWidget;
class QLabel;

namespace catcut {

class ProjectModel;

// S0 skeleton main window: four QDockWidget panels (media library, preview,
// timeline, inspector). Every panel can dock, float and be dragged to a
// second screen. Workspace state is saved/restored via QSettings.
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(QWidget* parent = nullptr);
    ~MainWindow() override;

    bool openProject(const QString& path);

protected:
    void closeEvent(QCloseEvent* event) override;

private slots:
    void onNewProject();
    void onOpenProject();
    void onSaveProject();
    void onSaveProjectAs();
    void onSaveWorkspace();
    void onRestoreDefaultLayout();

private:
    void setupDocks();
    void setupMenus();
    void applyDefaultLayout();
    void restoreWorkspace();
    void saveWorkspace() const;
    void updateWindowTitle();

    std::unique_ptr<ProjectModel> m_project;
    QString m_projectPath;

    QDockWidget* m_mediaDock = nullptr;
    QDockWidget* m_previewDock = nullptr;
    QDockWidget* m_timelineDock = nullptr;
    QDockWidget* m_inspectorDock = nullptr;
};

}
