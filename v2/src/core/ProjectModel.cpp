#include "core/ProjectModel.h"

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>

namespace catcut {

ProjectModel::ProjectModel()
    : m_title(QStringLiteral("未命名工程"))
{
}

void ProjectModel::setCanvasSize(int width, int height)
{
    if (width > 0)
        m_canvasWidth = width;
    if (height > 0)
        m_canvasHeight = height;
}

QString ProjectModel::displayTitle() const
{
    return m_title.isEmpty() ? QStringLiteral("未命名工程") : m_title;
}

bool ProjectModel::loadFromFile(const QString& path, QString& error)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        error = QStringLiteral("打不开工程文件：%1").arg(path);
        return false;
    }
    const QByteArray data = file.readAll();
    file.close();

    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(data, &parseError);
    if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
        error = QStringLiteral("工程文件不是有效的 JSON：%1").arg(parseError.errorString());
        return false;
    }
    const QJsonObject root = doc.object();

    if (root.value(QStringLiteral("format")).toString() != QString::fromLatin1(kFormat)) {
        error = QStringLiteral("不是 CatCut 工程文件（format 不是 catcut-editor）。");
        return false;
    }

    const QJsonValue versionValue = root.value(QStringLiteral("version"));
    if (!versionValue.isDouble()) {
        error = QStringLiteral("工程文件缺少 version 字段。");
        return false;
    }
    const int version = versionValue.toInt();
    if (version > kCurrentVersion) {
        error = QStringLiteral("工程版本过新（version %1，高于本软件支持的 %2），请用更新的 CatCut 打开。")
                    .arg(version)
                    .arg(kCurrentVersion);
        return false;
    }
    if (version < 1) {
        error = QStringLiteral("工程版本过旧（version %1），无法打开。").arg(version);
        return false;
    }

    m_title = root.value(QStringLiteral("title")).toString(QStringLiteral("未命名工程"));

    const QJsonObject canvas = root.value(QStringLiteral("canvas")).toObject();
    const int width = canvas.value(QStringLiteral("width")).toInt(1920);
    const int height = canvas.value(QStringLiteral("height")).toInt(1080);
    if (width <= 0 || height <= 0) {
        error = QStringLiteral("工程文件里的 canvas 尺寸无效（%1x%2）。").arg(width).arg(height);
        return false;
    }
    m_canvasWidth = width;
    m_canvasHeight = height;
    return true;
}

bool ProjectModel::saveToFile(const QString& path, QString& error) const
{
    QJsonObject canvas;
    canvas.insert(QStringLiteral("width"), m_canvasWidth);
    canvas.insert(QStringLiteral("height"), m_canvasHeight);

    QJsonObject root;
    root.insert(QStringLiteral("format"), QString::fromLatin1(kFormat));
    root.insert(QStringLiteral("version"), kCurrentVersion);
    root.insert(QStringLiteral("title"), m_title);
    root.insert(QStringLiteral("canvas"), canvas);

    const QJsonDocument doc(root);

    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) {
        error = QStringLiteral("写不进工程文件：%1").arg(path);
        return false;
    }
    file.write(doc.toJson(QJsonDocument::Indented));
    if (!file.commit()) {
        error = QStringLiteral("保存工程文件失败：%1").arg(path);
        return false;
    }
    return true;
}

}
