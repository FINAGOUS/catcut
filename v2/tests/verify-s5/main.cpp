// CatCut v2 — S5 self-test (verify-s5).
//
// Usage: verify-s5 <output-dir>
//   output-dir: created if missing; no files are written (the dialog is
//               exercised headless, never shown, never exported).
//
// Checks (exit 0 = all passed; run with QT_QPA_PLATFORM=offscreen):
//   1. export dialog offers all 6 S4 built-in presets
//      (1080p/4K/8K x H.264/H.265), default 1080p H.264
//   2. default bitrate equals the S4 recommended bitrate for 1080p30
//   3. export is disabled for an empty timeline (no silent no-op export)
//   4. export is enabled once the timeline has a clip
//   5. all 6 built-in presets are valid and the 8K tier math clamps to
//      the 130 Mbps cap (S4 formula, checked through the dialog's
//      preset path, not re-derived here)

#include <QApplication>
#include <QDir>
#include <QTextStream>

#include "core/ExportPreset.h"
#include "core/Roles.h"
#include "core/TimelineModel.h"
#include "ui/ExportDialog.h"

namespace {

int g_failures = 0;

void check(bool ok, const QString& name, const QString& detail = QString())
{
    QTextStream out(stdout);
    if (ok) {
        out << "[PASS] " << name;
    } else {
        out << "[FAIL] " << name;
        ++g_failures;
    }
    if (!detail.isEmpty())
        out << " — " << detail;
    out << "\n";
    out.flush();
}

} // namespace

int main(int argc, char* argv[])
{
    QApplication app(argc, argv);

    QTextStream out(stdout);
    out << "verify-s5: CatCut v2 S5 export-dialog self-test\n";
    out << "Qt: " << qVersion() << "\n";
    out.flush();

    if (argc < 2) {
        out << "usage: verify-s5 <output-dir>\n";
        return 2;
    }
    const QDir outDir(QString::fromLocal8Bit(argv[1]));
    if (!outDir.exists())
        QDir().mkpath(outDir.absolutePath());

    // --- 1+2: presets and default bitrate on an empty timeline. ---
    catcut::TimelineModel emptyModel;
    catcut::ExportDialog emptyDialog(&emptyModel);
    check(emptyDialog.presetCount() == 6, "export-ui: 6 built-in presets offered",
          QString::number(emptyDialog.presetCount()));
    check(emptyDialog.currentPresetName() == QStringLiteral("1080p H.264"),
          "export-ui: default preset is 1080p H.264", emptyDialog.currentPresetName());
    const qint64 expected1080p =
        catcut::recommendedBitrateBps(1920, 1080, 30.0);
    check(emptyDialog.currentBitrateBps() == expected1080p,
          "export-ui: default bitrate is the S4 recommended 1080p30 bitrate",
          QString::number(emptyDialog.currentBitrateBps()));

    // --- 3: empty timeline cannot export. ---
    check(!emptyDialog.exportEnabled(),
          "export-ui: export disabled for an empty timeline");

    // --- 4: one clip enables export (title clip: no media file needed,
    // the dialog only gates on the model being non-empty). ---
    catcut::TimelineModel model;
    catcut::Clip title;
    title.name = QStringLiteral("T");
    title.text = QStringLiteral("T");
    title.kind = catcut::ClipKind::Title;
    title.role = catcut::RoleNames::kTitle;
    title.sourceIn = 0.0;
    title.sourceOut = 2.0;
    model.appendPrimaryClip(title);
    catcut::ExportDialog dialog(&model);
    check(dialog.exportEnabled(),
          "export-ui: export enabled once the timeline has a clip");

    // --- 5: all builtins valid; 8K clamps to the 130 Mbps cap. ---
    bool allValid = true;
    QString invalidName;
    for (const catcut::ExportPreset& preset : catcut::builtinExportPresets()) {
        QString error;
        if (!preset.isValid(error)) {
            allValid = false;
            invalidName = preset.name + QStringLiteral(": ") + error;
        }
    }
    check(allValid, "export-ui: all 6 built-in presets are valid", invalidName);
    const catcut::ExportPreset* preset8k =
        catcut::findBuiltinPreset(QStringLiteral("8K H.265"));
    check(preset8k != nullptr, "export-ui: 8K H.265 preset exists");
    if (preset8k) {
        check(preset8k->bitrateBps() == 130000000,
              "export-ui: 8K recommended bitrate clamps to the 130 Mbps cap",
              QString::number(preset8k->bitrateBps()));
    }

    out << (g_failures == 0 ? "VERIFY-S5 RESULT: PASS\n"
                            : QStringLiteral("VERIFY-S5 RESULT: FAIL (%1 failures)\n")
                                  .arg(g_failures));
    out.flush();
    return g_failures == 0 ? 0 : 1;
}
