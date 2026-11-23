#pragma once

#include <QString>

namespace catcut {

// Minimal .catcut project model (S0 skeleton).
//
// On-disk format: single JSON file, top level:
//   { "format": "catcut-editor", "version": 1,
//     "title": "...", "canvas": { "width": 1920, "height": 1080 } }
//
// Version policy (from the architecture doc, section 10): a file whose
// version is newer than kCurrentVersion is refused with a readable error;
// unknown fields are ignored.
class ProjectModel {
public:
    static constexpr int kCurrentVersion = 1;
    static constexpr const char* kFormat = "catcut-editor";

    ProjectModel();

    const QString& title() const { return m_title; }
    void setTitle(const QString& title) { m_title = title; }

    int canvasWidth() const { return m_canvasWidth; }
    int canvasHeight() const { return m_canvasHeight; }
    void setCanvasSize(int width, int height);

    // Loads a .catcut file. Returns false and fills `error` with a
    // human-readable reason on any failure (bad JSON, wrong format,
    // unsupported version, invalid canvas).
    bool loadFromFile(const QString& path, QString& error);

    // Saves atomically (temp file + atomic move, via QSaveFile).
    bool saveToFile(const QString& path, QString& error) const;

    QString displayTitle() const;

private:
    QString m_title;
    int m_canvasWidth = 1920;
    int m_canvasHeight = 1080;
};
}
