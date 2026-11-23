// CatCut v2 — S4 subtitles: track model + SRT import/export.
//
// Times are seconds (project time). The track lives on TimelineModel
// (project-level subtitles); the evaluator exposes the active item at
// time t on FrameScene and TimelineFrameRenderer burns it into the
// frame — the same shared render path for preview and export, so a
// burned subtitle looks identical in both (hard rule 5).
//
// SRT format follows the old TS engine spec (subtitles.ts): timecode
// HH:MM:SS,mmm, one blank line between blocks, text lines after the
// timecode line (an optional numeric index line is accepted on read).

#pragma once

#include <QJsonObject>
#include <QList>
#include <QString>

namespace catcut {

struct SubtitleItem {
    QString text;
    double start = 0.0; // seconds
    double end = 0.0;   // seconds

    bool isValid() const { return !text.isEmpty() && end > start && start >= 0.0; }
    double duration() const { return end - start; }

    QJsonObject toJson() const;
    static SubtitleItem fromJson(const QJsonObject& object, bool& ok);
};

class SubtitleTrack {
public:
    SubtitleTrack();

    const QList<SubtitleItem>& items() const { return m_items; }
    void setItems(const QList<SubtitleItem>& items) { m_items = items; }
    void addItem(const SubtitleItem& item); // keeps the list sorted
    void clear() { m_items.clear(); }
    bool isEmpty() const { return m_items.isEmpty(); }
    int count() const { return m_items.size(); }

    // Index of the item active at `timeSeconds`, or -1.
    int indexAt(double timeSeconds) const;
    const SubtitleItem* itemAt(double timeSeconds) const;

    // SRT serialisation (toSrt) / parsing (parseSrt). parseSrt returns
    // false with a readable `error` on a bad timecode; blocks without
    // a timecode line are skipped, not fatal.
    QString toSrt() const;
    static bool parseSrt(const QString& text, SubtitleTrack& out, QString& error);

    QJsonObject toJson() const;
    static SubtitleTrack fromJson(const QJsonObject& object);

    static QString formatSrtTime(double seconds);
    static bool parseSrtTime(const QString& text, double& secondsOut);

private:
    QList<SubtitleItem> m_items;
};

} // namespace catcut
