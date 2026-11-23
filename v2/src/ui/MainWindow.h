#pragma once

#include <QList>
#include <QMainWindow>
#include <QString>
#include <memory>

class QDockWidget;
class QLabel;
class QTableWidget;

namespace catcut {

class ProjectModel;
class PreviewWidget;
class ProxyJob;

// S1 main window: four QDockWidget panels (media library, preview,
// timeline, inspector). Every panel can dock, float and be dragged to a
// second screen. Workspace state is saved/restored via QSettings.
//
// S1 additions: the media library is a real table (file / resolution /
// duration / proxy status) with an import button; importing a file
// probes it, renders its first frame into the preview panel
// (PreviewWidget) and starts a background 720p proxy job whose status
// is shown in the table. A failed/missing proxy is shown as a hard
// error — playback never silently falls back to the original.
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
    void onImportMedia();
    void onProxyFinished(int row, bool ok, const QString& error, const QString& encoderUsed);

private:
    void setupDocks();
    void setupMenus();
    void applyDefaultLayout();
    void restoreWorkspace();
    void saveWorkspace() const;
    void updateWindowTitle();

    struct ImportedMedia {
        QString path;
        QString proxyPath;
        std::shared_ptr<ProxyJob> proxyJob;
    };
    QList<ImportedMedia> m_media;

    std::unique_ptr<ProjectModel> m_project;
    QString m_projectPath;

    QDockWidget* m_mediaDock = nullptr;
    QDockWidget* m_previewDock = nullptr;
    QDockWidget* m_timelineDock = nullptr;
    QDockWidget* m_inspectorDock = nullptr;

    QTableWidget* m_mediaTable = nullptr;
    PreviewWidget* m_previewWidget = nullptr;
    QLabel* m_previewStatus = nullptr;
};

}
