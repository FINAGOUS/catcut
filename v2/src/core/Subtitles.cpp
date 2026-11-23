#include "core/Subtitles.h"

#include <QJsonArray>
#include <QRegularExpression>
#include <algorithm>

namespace catcut {

QJsonObject SubtitleItem::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("text"), text);
    o.insert(QStringLiteral("start"), start);
    o.insert(QStringLiteral("end"), end);
    return o;
}

SubtitleItem SubtitleItem::fromJson(const QJsonObject& object, bool& ok)
{
    SubtitleItem item;
    ok = object.contains(QStringLiteral("text"))
        && object.contains(QStringLiteral("start"))
        && object.contains(QStringLiteral("end"));
    if (!ok)
        return item;
    item.text = object.value(QStringLiteral("text")).toString();
    item.start = object.value(QStringLiteral("start")).toDouble();
    item.end = object.value(QStringLiteral("end")).toDouble();
    ok = item.isValid();
    return item;
}

SubtitleTrack::SubtitleTrack() = default;

void SubtitleTrack::addItem(const SubtitleItem& item)
{
    m_items.append(item);
    std::sort(m_items.begin(), m_items.end(),
              [](const SubtitleItem& a, const SubtitleItem& b) { return a.start < b.start; });
}

int SubtitleTrack::indexAt(double timeSeconds) const
{
    for (int i = 0; i < m_items.size(); ++i) {
        if (timeSeconds >= m_items[i].start - 1e-9 && timeSeconds < m_items[i].end - 1e-9)
            return i;
    }
    return -1;
}

const SubtitleItem* SubtitleTrack::itemAt(double timeSeconds) const
{
    const int index = indexAt(timeSeconds);
    return index >= 0 ? &m_items[index] : nullptr;
}

QString SubtitleTrack::formatSrtTime(double seconds)
{
    const long long totalMs = std::max(0LL, static_cast<long long>(std::llround(seconds * 1000.0)));
    const long long ms = totalMs % 1000;
    const long long s = (totalMs / 1000) % 60;
    const long long m = (totalMs / 60000) % 60;
    const long long h = totalMs / 3600000;
    return QStringLiteral("%1:%2:%3,%4")
        .arg(h, 2, 10, QLatin1Char('0'))
        .arg(m, 2, 10, QLatin1Char('0'))
        .arg(s, 2, 10, QLatin1Char('0'))
        .arg(ms, 3, 10, QLatin1Char('0'));
}

bool SubtitleTrack::parseSrtTime(const QString& text, double& secondsOut)
{
    static const QRegularExpression re(
        QStringLiteral(R"(^\s*(\d+):(\d+):(\d+)[,.](\d+)\s*$)"));
    const QRegularExpressionMatch match = re.match(text.trimmed());
    if (!match.hasMatch())
        return false;
    secondsOut = match.captured(1).toDouble() * 3600.0
        + match.captured(2).toDouble() * 60.0
        + match.captured(3).toDouble()
        + match.captured(4).toDouble() / 1000.0;
    return true;
}

QString SubtitleTrack::toSrt() const
{
    QString out;
    for (int i = 0; i < m_items.size(); ++i) {
        out += QString::number(i + 1) + QStringLiteral("\n");
        out += formatSrtTime(m_items[i].start) + QStringLiteral(" --> ")
            + formatSrtTime(m_items[i].end) + QStringLiteral("\n");
        out += m_items[i].text + QStringLiteral("\n\n");
    }
    return out;
}

bool SubtitleTrack::parseSrt(const QString& text, SubtitleTrack& out, QString& error)
{
    out.clear();
    const QString normalised = QString(text).replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
    const QStringList blocks = normalised.split(QStringLiteral("\n\n"), Qt::SkipEmptyParts);
    for (const QString& block : blocks) {
        const QStringList lines = block.split(QStringLiteral("\n"), Qt::SkipEmptyParts);
        if (lines.isEmpty())
            continue;
        int tcIndex = -1;
        for (int i = 0; i < lines.size(); ++i) {
            if (lines[i].contains(QStringLiteral("-->"))) {
                tcIndex = i;
                break;
            }
        }
        if (tcIndex < 0)
            continue; // block without a timecode line: skipped, not fatal
        const QStringList parts = lines[tcIndex].split(QStringLiteral("-->"));
        if (parts.size() != 2) {
            error = QStringLiteral("字幕：时间码行无法解析：%1").arg(lines[tcIndex]);
            return false;
        }
        double start = 0.0, end = 0.0;
        if (!parseSrtTime(parts[0], start) || !parseSrtTime(parts[1], end)) {
            error = QStringLiteral("字幕：时间码无法解析：%1").arg(lines[tcIndex]);
            return false;
        }
        QStringList textLines;
        for (int i = tcIndex + 1; i < lines.size(); ++i)
            textLines.append(lines[i]);
        SubtitleItem item;
        item.text = textLines.join(QStringLiteral("\n"));
        item.start = start;
        item.end = end;
        if (!item.isValid()) {
            error = QStringLiteral("字幕：无效条目（%1 --> %2）。").arg(start).arg(end);
            return false;
        }
        out.addItem(item);
    }
    return true;
}

QJsonObject SubtitleTrack::toJson() const
{
    QJsonObject o;
    QJsonArray items;
    for (const SubtitleItem& item : m_items)
        items.append(item.toJson());
    o.insert(QStringLiteral("items"), items);
    return o;
}

SubtitleTrack SubtitleTrack::fromJson(const QJsonObject& object)
{
    SubtitleTrack track;
    const QJsonArray items = object.value(QStringLiteral("items")).toArray();
    for (const QJsonValue& v : items) {
        bool ok = false;
        const SubtitleItem item = SubtitleItem::fromJson(v.toObject(), ok);
        if (ok)
            track.addItem(item);
    }
    return track;
}

} // namespace catcut
