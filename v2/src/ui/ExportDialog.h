// CatCut v2 — S5 export dialog.
//
// File -> 导出: preset picker (1080p/4K/8K x H.264/H.265, four bitrate
// tiers), output path picker, progress bar, cancel button. The export
// itself runs on a worker thread through the S4 ExportPipeline — no
// second export path is introduced here (hard rule 5: preview and
// export share one render path, and the dialog does not reimplement
// it). The dialog is modal, so the timeline model cannot be edited
// while the worker thread reads it.
//
// Failure is reported, never silent and never a crash: a failed
// export shows the pipeline's readable error in a message box and in
// the status line (e.g. "no hardware HEVC encoder on this machine,
// use H.264 instead"). Cancelling deletes the partial output file
// (ExportPipeline guarantees that).

#pragma once

#include <QDialog>
#include <atomic>

#include "core/ExportPreset.h"

class QComboBox;
class QLabel;
class QLineEdit;
class QProgressBar;
class QPushButton;
class QSpinBox;
class QThread;

namespace catcut {

class TimelineModel;

class ExportDialog : public QDialog {
    Q_OBJECT
public:
    // `model` is borrowed and must outlive the dialog. It is only read
    // by the export worker thread while this modal dialog is open.
    explicit ExportDialog(const TimelineModel* model, QWidget* parent = nullptr);
    ~ExportDialog() override;

    // Test hooks (used by verify-s5, headless offscreen).
    int presetCount() const;
    QString currentPresetName() const;
    qint64 currentBitrateBps() const;
    bool exportEnabled() const;

private slots:
    void onPresetChanged(int index);
    void onTierChanged(int index);
    void onBrowseOutput();
    void onExportClicked();
    void onCancelClicked();
    void onExportProgress(int done, int total);
    // Worker-thread result, delivered as plain values (no custom
    // metatype needed for the queued connection).
    void onExportFinished(bool ok, bool cancelled, const QString& error,
                          const QString& encoderName, bool hardwareEncoder,
                          const QString& fallbackNote, double loudnessLUFS,
                          bool hasAudio);

private:
    ExportPreset currentPreset() const;
    void updateBitrateLabel();
    void updateOutputExtension();
    void setExporting(bool exporting);

    const TimelineModel* m_model = nullptr;

    QComboBox* m_presetCombo = nullptr;
    QComboBox* m_tierCombo = nullptr;
    QSpinBox* m_customBitrateSpin = nullptr; // Mbps, only for Custom tier
    QLabel* m_bitrateLabel = nullptr;
    QLineEdit* m_outputEdit = nullptr;
    QPushButton* m_browseButton = nullptr;
    QProgressBar* m_progressBar = nullptr;
    QLabel* m_statusLabel = nullptr;
    QPushButton* m_exportButton = nullptr;
    QPushButton* m_cancelButton = nullptr;

    std::atomic<bool> m_cancel{false};
    QThread* m_exportThread = nullptr;
    bool m_exporting = false;
};

} // namespace catcut
