#pragma once

#include <QList>
#include <QMainWindow>
#include <QPoint>
#include <QString>
#include <memory>

class QDockWidget;
class QLabel;
class QTableWidget;

namespace catcut {

class ColorPanelWidget;
class ProjectModel;
class PreviewWidget;
class ProxyJob;
class TimelineWidget;
class InspectorWidget;
class KeyframeChartWidget;

// S2 main window: four QDockWidget panels (media library, preview,
// timeline, inspector). Every panel can dock, float and be dragged to
// a second screen. Workspace state is saved/restored via QSettings.
//
// S1: the media library is a real table (file / resolution / duration
// / proxy status) with an import button; importing a file probes it,
// renders its first frame into the preview panel and starts a
// background 720p proxy job.
// S2: the timeline dock holds the real TimelineWidget (replacing the
// S1 placeholder) with its toolbar; the inspector dock holds the
// InspectorWidget + keyframe chart. Dragging a media row onto the
// timeline adds a clip there; the preview renders the timeline frame
// at the playhead through TimelineEvaluator + TimelineFrameRenderer
// (the same path S4 export will use).
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(QWidget* parent = nullptr);
    ~MainWindow() override;

    bool openProject(const QString& path);

protected:
    void closeEvent(QCloseEvent* event) override;
    bool eventFilter(QObject* watched, QEvent* event) override;

private slots:
    void onNewProject();
    void onOpenProject();
    void onSaveProject();
    void onSaveProjectAs();
    void onSaveWorkspace();
    void onRestoreDefaultLayout();
    void onImportMedia();
    void onExport();
    void onVocalSeparate(); // S6: centre-elimination vocal separation
    void onProxyFinished(int row, bool ok, const QString& error, const QString& encoderUsed);
    void onTimelineChanged();
    void onTimelineSelectionChanged();
    void onPlayheadChanged(double seconds);

private:
    void setupDocks();
    void setupMenus();
    void applyDefaultLayout();
    void restoreWorkspace();
    void saveWorkspace() const;
    void updateWindowTitle();
    void renderPreviewAtPlayhead();
    void refreshInspector();

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
    QDockWidget* m_colorDock = nullptr;
    QDockWidget* m_audioDock = nullptr; // S6: vocal separation (centre)

    QTableWidget* m_mediaTable = nullptr;
    PreviewWidget* m_previewWidget = nullptr;
    QLabel* m_previewStatus = nullptr;
    TimelineWidget* m_timelineWidget = nullptr;
    InspectorWidget* m_inspectorWidget = nullptr;
    KeyframeChartWidget* m_chartWidget = nullptr;
    ColorPanelWidget* m_colorPanel = nullptr;

    // Media-library drag source state (event filter on the table viewport).
    QPoint m_mediaDragStart;
    int m_mediaDragRow = -1;
};

}
