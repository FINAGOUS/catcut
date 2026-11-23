// CatCut v2 — S2 timeline: timeline widget (Qt Widgets).
//
// Custom-painted timeline: ruler + playhead, lanes derived from the
// model (primary storyline, connected video lanes per role, audio
// lanes per role), clip blocks with drag / snap / trim, transitions
// on boundaries, and drops from the media library / the transition
// palette. The widget owns the TimelineModel; the inspector and the
// preview read the same model through MainWindow.
//
// Interactions:
//   * click ruler: move playhead (drag to scrub)
//   * drag clip body: move (primary = ripple move; connected = move
//     anchor; a clip in a secondary storyline moves the whole group)
//   * drag clip edge: ripple trim; Ctrl+drag a shared edge: roll trim
//   * double-click a primary boundary: add a dissolve transition
//   * drag a transition palette button onto a boundary: set it
//   * Ctrl+B split at playhead, Delete ripple-delete, V enable/disable
//   * drop a media file: append/insert a clip at the drop time

#pragma once

#include <QList>
#include <QString>
#include <QWidget>
#include <memory>

#include "core/TimelineModel.h"

class QDrag;
class QTimer;

namespace catcut {

class TimelineWidget : public QWidget {
    Q_OBJECT
public:
    explicit TimelineWidget(QWidget* parent = nullptr);
    ~TimelineWidget() override;

    TimelineModel* model() { return m_model.get(); }
    const TimelineModel* model() const { return m_model.get(); }

    double playhead() const { return m_playhead; }
    void setPlayhead(double seconds);
    double pixelsPerSecond() const { return m_pxPerSecond; }
    void setPixelsPerSecond(double px);

    QString selectedClipId() const;
    QList<QString> selectedClipIds() const { return m_selectedClipIds; }
    QString selectedTransitionLeftId() const { return m_selectedTransitionLeftId; }
    void clearSelection();

    bool isPlaying() const { return m_playing; }
    void setPlaying(bool playing);

    // Adds media at `time` (probe for duration first). Returns the new
    // clip id, or "" on failure (see lastError()).
    QString addMediaAt(const QString& path, double time);
    QString addTitleAt(const QString& text, double time, double duration = 3.0);
    const QString& lastError() const { return m_lastError; }

    // Toolbar: zoom slider + transition palette (draggable) + edit
    // buttons. The widget owns the buttons (for palette drag handling).
    QWidget* createToolbar();

    void splitAtPlayhead();
    void rippleDeleteSelected();
    void toggleSelectedEnabled();
    void disconnectSelected();
    void groupSelectedAsStoryline();
    void addTransitionAtBoundary(const QString& leftClipId, TransitionType type);

    QSize sizeHint() const override;

signals:
    void playheadChanged(double seconds);
    void selectionChanged();
    void modelChanged();

protected:
    void paintEvent(QPaintEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void mouseMoveEvent(QMouseEvent* event) override;
    void mouseReleaseEvent(QMouseEvent* event) override;
    void mouseDoubleClickEvent(QMouseEvent* event) override;
    void keyPressEvent(QKeyEvent* event) override;
    void dragEnterEvent(QDragEnterEvent* event) override;
    void dropEvent(QDropEvent* event) override;
    bool eventFilter(QObject* watched, QEvent* event) override;
    void contextMenuEvent(QContextMenuEvent* event) override;

private:
    enum class DragMode { None, Scrub, MoveClip, TrimLeft, TrimRight };

    struct HitClip {
        QString clipId;
        bool isPrimary = false;
        bool leftEdge = false;
        bool rightEdge = false;
    };

    // Geometry helpers (x in widget pixels, gutter included).
    static constexpr int kGutterWidth = 110;
    static constexpr int kRulerHeight = 28;
    static constexpr int kEdgeHit = 6;

    double timeAtX(int x) const;
    int xAtTime(double t) const;
    int laneHeight(const TimelineLane& lane) const;
    int laneTopY(int laneIndex) const;
    int laneCount() const;
    int laneAtY(int y) const;
    HitClip hitClipAt(const QPoint& pos) const;
    // Primary boundary (cut time + left clip id) near x, or false.
    bool boundaryNearX(int x, double& cutTimeOut, QString& leftClipIdOut) const;
    double snapTime(double t) const;
    void refreshSize();
    void selectClip(const QString& clipId, bool additive);
    void startPaletteDrag(QWidget* button, TransitionType type);
    QString clipDisplayName(const Clip& clip) const;

    std::unique_ptr<TimelineModel> m_model = std::make_unique<TimelineModel>();
    double m_playhead = 0.0;
    double m_pxPerSecond = 80.0;
    QList<QString> m_selectedClipIds;
    QString m_selectedTransitionLeftId;

    DragMode m_dragMode = DragMode::None;
    QString m_dragClipId;
    bool m_dragClipPrimary = false;
    double m_dragStartTime = 0.0;
    double m_dragPreviewTime = 0.0; // clip start (move) or edge time (trim)
    double m_dragGrabOffset = 0.0;  // press time - clip start
    bool m_dragRoll = false;
    QPoint m_pressPos;

    bool m_playing = false;
    QTimer* m_playTimer = nullptr;
    QString m_lastError;

    QList<QWidget*> m_paletteButtons;
};

} // namespace catcut
