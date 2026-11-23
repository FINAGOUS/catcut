// CatCut v2 — S0 skeleton entry point.
// --version and --smoke-test are handled before any GUI object exists so
// they work headless (CI smoke test needs no display server).

#include <QApplication>
#include <QString>
#include <iostream>

#include "ui/MainWindow.h"

namespace {
#ifdef CATCUT_VERSION_STRING
constexpr const char* kVersion = CATCUT_VERSION_STRING;
#else
constexpr const char* kVersion = "v2.0.0-alpha.1";
#endif
}

int main(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i) {
        const QString arg = QString::fromLocal8Bit(argv[i]);
        if (arg == QStringLiteral("--version")) {
            std::cout << "CatCut v2 " << kVersion << std::endl;
            return 0;
        }
        if (arg == QStringLiteral("--smoke-test")) {
            std::cout << "CatCut v2 smoke OK" << std::endl;
            return 0;
        }
    }

    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("CatCut"));
    QApplication::setApplicationVersion(QString::fromLatin1(kVersion));
    QApplication::setOrganizationName(QStringLiteral("CatCut"));

    catcut::MainWindow window;

    // Optional: `CatCut-v2.exe foo.catcut` opens the project on startup.
    for (int i = 1; i < argc; ++i) {
        const QString arg = QString::fromLocal8Bit(argv[i]);
        if (arg.endsWith(QStringLiteral(".catcut"), Qt::CaseInsensitive)) {
            window.openProject(arg);
            break;
        }
    }

    window.show();
    return app.exec();
}
