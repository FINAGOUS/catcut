#include "ui/ExportDialog.h"

#include "core/TimelineModel.h"
#include "media/ExportPipeline.h"

#include <QComboBox>
#include <QDir>
#include <QFileDialog>
#include <QFileInfo>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QMessageBox>
#include <QProgressBar>
#include <QPushButton>
#include <QSpinBox>
#include <QStandardPaths>
#include <QThread>
#include <QVBoxLayout>

namespace catcut {

namespace {

// Worker object: lives on the export thread, owns nothing but the
// borrowed model pointer (the modal dialog guarantees the model is
// not edited while the thread runs) and the cancel flag.
class ExportWorker : public QObject {
    Q_OBJECT
public:
    ExportWorker(const TimelineModel* model, ExportPreset preset, QString outputPath,
                 std::atomic<bool>* cancel)
        : m_model(model)
        , m_preset(preset)
        , m_outputPath(std::move(outputPath))
        , m_cancel(cancel)
    {
    }

signals:
    void progress(int done, int total);
    void finished(bool ok, bool cancelled, const QString& error,
                  const QString& encoderName, bool hardwareEncoder,
                  const QString& fallbackNote, double loudnessLUFS, bool hasAudio);

public slots:
    void run()
    {
        ExportOptions options;
        options.cancel = m_cancel;
        options.progress = [this](int done, int total) { emit progress(done, total); };
        const ExportResult result =
            ExportPipeline::exportTimeline(m_model, m_preset, m_outputPath, options);
        emit finished(result.ok, result.cancelled, result.error, result.encoderName,
                      result.hardwareEncoder, result.fallbackNote, result.loudnessLUFS,
                      result.hasAudio);
    }

private:
    const TimelineModel* m_model = nullptr;
    ExportPreset m_preset;
    QString m_outputPath;
    std::atomic<bool>* m_cancel = nullptr;
};

QString tierDisplayName(BitrateTier tier)
{
    switch (tier) {
    case BitrateTier::Lower: return QStringLiteral("更低");
    case BitrateTier::Higher: return QStringLiteral("更高");
    case BitrateTier::Custom: return QStringLiteral("自定义");
    case BitrateTier::Recommended:
    default: return QStringLiteral("推荐");
    }
}

} // namespace

ExportDialog::ExportDialog(const TimelineModel* model, QWidget* parent)
    : QDialog(parent)
    , m_model(model)
{
    setWindowTitle(QStringLiteral("导出"));
    setMinimumWidth(460);

    auto* layout = new QVBoxLayout(this);

    // --- Preset row: 1080p/4K/8K x H.264/H.265 (S4 builtins). ---
    auto* presetRow = new QHBoxLayout();
    presetRow->addWidget(new QLabel(QStringLiteral("预设")));
    m_presetCombo = new QComboBox();
    for (const ExportPreset& preset : builtinExportPresets())
        m_presetCombo->addItem(preset.name);
    m_presetCombo->setCurrentIndex(0); // 1080p H.264
    connect(m_presetCombo, &QComboBox::currentIndexChanged,
            this, &ExportDialog::onPresetChanged);
    presetRow->addWidget(m_presetCombo, 1);
    layout->addLayout(presetRow);

    // --- Bitrate tier row: 更低/推荐/更高/自定义. ---
    auto* tierRow = new QHBoxLayout();
    tierRow->addWidget(new QLabel(QStringLiteral("码率")));
    m_tierCombo = new QComboBox();
    m_tierCombo->addItem(tierDisplayName(BitrateTier::Lower),
                         static_cast<int>(BitrateTier::Lower));
    m_tierCombo->addItem(tierDisplayName(BitrateTier::Recommended),
                         static_cast<int>(BitrateTier::Recommended));
    m_tierCombo->addItem(tierDisplayName(BitrateTier::Higher),
                         static_cast<int>(BitrateTier::Higher));
    m_tierCombo->addItem(tierDisplayName(BitrateTier::Custom),
                         static_cast<int>(BitrateTier::Custom));
    m_tierCombo->setCurrentIndex(1); // 推荐
    connect(m_tierCombo, &QComboBox::currentIndexChanged,
            this, &ExportDialog::onTierChanged);
    tierRow->addWidget(m_tierCombo);
    m_customBitrateSpin = new QSpinBox();
    m_customBitrateSpin->setRange(1, 200);
    m_customBitrateSpin->setValue(20);
    m_customBitrateSpin->setSuffix(QStringLiteral(" Mbps"));
    m_customBitrateSpin->setVisible(false);
    connect(m_customBitrateSpin, &QSpinBox::valueChanged,
            this, [this]() { updateBitrateLabel(); });
    tierRow->addWidget(m_customBitrateSpin);
    m_bitrateLabel = new QLabel();
    tierRow->addWidget(m_bitrateLabel, 1);
    layout->addLayout(tierRow);

    // --- Output path row. ---
    auto* outputRow = new QHBoxLayout();
    outputRow->addWidget(new QLabel(QStringLiteral("输出到")));
    m_outputEdit = new QLineEdit();
    const QString moviesDir =
        QStandardPaths::writableLocation(QStandardPaths::MoviesLocation);
    m_outputEdit->setText(QDir(moviesDir).filePath(QStringLiteral("CatCut 导出.mp4")));
    outputRow->addWidget(m_outputEdit, 1);
    m_browseButton = new QPushButton(QStringLiteral("浏览…"));
    connect(m_browseButton, &QPushButton::clicked, this, &ExportDialog::onBrowseOutput);
    outputRow->addWidget(m_browseButton);
    layout->addLayout(outputRow);

    // --- Progress + status. ---
    m_progressBar = new QProgressBar();
    m_progressBar->setRange(0, 100);
    m_progressBar->setValue(0);
    layout->addWidget(m_progressBar);
    m_statusLabel = new QLabel(QStringLiteral("就绪"));
    m_statusLabel->setWordWrap(true);
    layout->addWidget(m_statusLabel);

    // --- Buttons. ---
    auto* buttonRow = new QHBoxLayout();
    buttonRow->addStretch(1);
    m_exportButton = new QPushButton(QStringLiteral("开始导出"));
    connect(m_exportButton, &QPushButton::clicked, this, &ExportDialog::onExportClicked);
    buttonRow->addWidget(m_exportButton);
    m_cancelButton = new QPushButton(QStringLiteral("关闭"));
    connect(m_cancelButton, &QPushButton::clicked, this, &ExportDialog::onCancelClicked);
    buttonRow->addWidget(m_cancelButton);
    layout->addLayout(buttonRow);

    updateBitrateLabel();
    if (!m_model || m_model->isEmpty()) {
        m_exportButton->setEnabled(false);
        m_statusLabel->setText(
            QStringLiteral("时间线为空：先导入媒体并拖到时间线上，再导出。"));
    }
}

ExportDialog::~ExportDialog()
{
    // If the dialog is destroyed mid-export (should not happen while
    // modal, but be safe), stop the worker and wait for the thread.
    if (m_exportThread) {
        m_cancel.store(true);
        m_exportThread->quit();
        m_exportThread->wait();
    }
}

int ExportDialog::presetCount() const
{
    return m_presetCombo ? m_presetCombo->count() : 0;
}

QString ExportDialog::currentPresetName() const
{
    return m_presetCombo ? m_presetCombo->currentText() : QString();
}

qint64 ExportDialog::currentBitrateBps() const
{
    return currentPreset().bitrateBps();
}

bool ExportDialog::exportEnabled() const
{
    return m_exportButton && m_exportButton->isEnabled();
}

ExportPreset ExportDialog::currentPreset() const
{
    ExportPreset preset;
    const QString name = m_presetCombo ? m_presetCombo->currentText() : QString();
    if (const ExportPreset* builtin = findBuiltinPreset(name))
        preset = *builtin;
    preset.tier = static_cast<BitrateTier>(
        m_tierCombo ? m_tierCombo->currentData().toInt()
                    : static_cast<int>(BitrateTier::Recommended));
    if (preset.tier == BitrateTier::Custom && m_customBitrateSpin)
        preset.customBitrateBps =
            static_cast<qint64>(m_customBitrateSpin->value()) * 1000000;
    return preset;
}

void ExportDialog::updateBitrateLabel()
{
    const ExportPreset preset = currentPreset();
    m_bitrateLabel->setText(
        QStringLiteral("%1x%2 · %3 fps · 约 %4 Mbps")
            .arg(preset.width)
            .arg(preset.height)
            .arg(preset.fps, 0, 'f', 0)
            .arg(preset.bitrateBps() / 1000000.0, 0, 'f', 1));
}

void ExportDialog::updateOutputExtension()
{
    // Keep the output extension in step with the preset container.
    QString path = m_outputEdit->text().trimmed();
    if (path.isEmpty())
        return;
    const QString ext = currentPreset().containerExtension();
    if (!path.endsWith(QLatin1Char('.') + ext, Qt::CaseInsensitive)) {
        const int dot = path.lastIndexOf(QLatin1Char('.'));
        const int slash = qMax(path.lastIndexOf(QLatin1Char('/')),
                               path.lastIndexOf(QLatin1Char('\\')));
        if (dot > slash)
            path = path.left(dot);
        m_outputEdit->setText(path + QLatin1Char('.') + ext);
    }
}

void ExportDialog::onPresetChanged(int /*index*/)
{
    updateOutputExtension();
    updateBitrateLabel();
}

void ExportDialog::onTierChanged(int /*index*/)
{
    const bool custom = m_tierCombo
        && static_cast<BitrateTier>(m_tierCombo->currentData().toInt())
               == BitrateTier::Custom;
    if (m_customBitrateSpin)
        m_customBitrateSpin->setVisible(custom);
    updateBitrateLabel();
}

void ExportDialog::onBrowseOutput()
{
    const QString ext = currentPreset().containerExtension();
    const QString filter = ext == QStringLiteral("mov")
        ? QStringLiteral("MOV 视频 (*.mov);;MP4 视频 (*.mp4)")
        : QStringLiteral("MP4 视频 (*.mp4);;MOV 视频 (*.mov)");
    const QString path = QFileDialog::getSaveFileName(
        this, QStringLiteral("选择导出位置"), m_outputEdit->text(), filter);
    if (!path.isEmpty())
        m_outputEdit->setText(path);
}

void ExportDialog::setExporting(bool exporting)
{
    m_exporting = exporting;
    m_presetCombo->setEnabled(!exporting);
    m_tierCombo->setEnabled(!exporting);
    if (m_customBitrateSpin)
        m_customBitrateSpin->setEnabled(!exporting);
    m_outputEdit->setEnabled(!exporting);
    m_browseButton->setEnabled(!exporting);
    m_exportButton->setEnabled(!exporting);
    m_cancelButton->setText(exporting ? QStringLiteral("取消导出")
                                      : QStringLiteral("关闭"));
}

void ExportDialog::onExportClicked()
{
    if (!m_model || m_model->isEmpty()) {
        QMessageBox::warning(this, QStringLiteral("无法导出"),
                             QStringLiteral("时间线为空：先导入媒体并拖到时间线上，再导出。"));
        return;
    }
    const ExportPreset preset = currentPreset();
    QString presetError;
    if (!preset.isValid(presetError)) {
        QMessageBox::warning(this, QStringLiteral("预设无效"), presetError);
        return;
    }
    const QString outputPath = m_outputEdit->text().trimmed();
    if (outputPath.isEmpty()) {
        QMessageBox::warning(this, QStringLiteral("缺少输出路径"),
                             QStringLiteral("请先选择导出文件的保存位置。"));
        return;
    }
    // ExportPipeline requires the output directory to exist.
    const QString outputDir = QFileInfo(outputPath).absolutePath();
    if (!QDir().mkpath(outputDir)) {
        QMessageBox::critical(
            this, QStringLiteral("导出失败"),
            QStringLiteral("无法创建输出目录：%1").arg(outputDir));
        return;
    }
    if (QFileInfo::exists(outputPath)) {
        if (QMessageBox::question(
                this, QStringLiteral("覆盖已有文件"),
                QStringLiteral("文件 %1 已存在，是否覆盖？").arg(outputPath))
            != QMessageBox::Yes)
            return;
    }

    m_cancel.store(false);
    m_progressBar->setValue(0);
    m_statusLabel->setText(QStringLiteral("正在导出…"));
    setExporting(true);

    auto* worker = new ExportWorker(m_model, preset, outputPath, &m_cancel);
    m_exportThread = new QThread(this);
    worker->moveToThread(m_exportThread);
    connect(m_exportThread, &QThread::started, worker, &ExportWorker::run);
    connect(worker, &ExportWorker::progress,
            this, &ExportDialog::onExportProgress);
    connect(worker, &ExportWorker::finished,
            this, &ExportDialog::onExportFinished);
    connect(worker, &ExportWorker::finished, worker, &QObject::deleteLater);
    connect(m_exportThread, &QThread::finished,
            m_exportThread, &QObject::deleteLater);
    m_exportThread->start();
}

void ExportDialog::onCancelClicked()
{
    if (m_exporting) {
        // The worker polls the flag every frame; the pipeline deletes
        // the partial output file on cancel.
        m_cancel.store(true);
        m_cancelButton->setEnabled(false);
        m_cancelButton->setText(QStringLiteral("正在取消…"));
        m_statusLabel->setText(QStringLiteral("正在取消导出…"));
        return;
    }
    reject();
}

void ExportDialog::onExportProgress(int done, int total)
{
    if (total > 0)
        m_progressBar->setValue(done * 100 / total);
    m_statusLabel->setText(
        QStringLiteral("正在导出… %1 / %2 帧").arg(done).arg(total));
}

void ExportDialog::onExportFinished(bool ok, bool cancelled, const QString& error,
                                    const QString& encoderName, bool hardwareEncoder,
                                    const QString& fallbackNote, double loudnessLUFS,
                                    bool hasAudio)
{
    if (m_exportThread) {
        m_exportThread->quit();
        m_exportThread->wait();
        m_exportThread = nullptr;
    }
    setExporting(false);
    m_cancelButton->setEnabled(true);

    if (cancelled) {
        m_progressBar->setValue(0);
        m_statusLabel->setText(QStringLiteral("导出已取消，未保留未完成的文件。"));
        return;
    }
    if (!ok) {
        // Readable error, never a silent failure and never a crash.
        m_progressBar->setValue(0);
        m_statusLabel->setText(QStringLiteral("导出失败：%1").arg(error));
        QMessageBox::critical(this, QStringLiteral("导出失败"), error);
        return;
    }
    m_progressBar->setValue(100);
    QString summary = QStringLiteral("导出完成。\n编码器：%1%2")
                          .arg(encoderName)
                          .arg(hardwareEncoder ? QStringLiteral("（硬件）")
                                               : QStringLiteral("（软件）"));
    if (!fallbackNote.isEmpty())
        summary += QStringLiteral("\n注意：%1").arg(fallbackNote);
    if (hasAudio)
        summary += QStringLiteral("\n成品响度：%1 LUFS（目标 -16）").arg(loudnessLUFS, 0, 'f', 2);
    m_statusLabel->setText(summary);
    QMessageBox::information(this, QStringLiteral("导出完成"), summary);
    accept();
}

} // namespace catcut

#include "ExportDialog.moc"
