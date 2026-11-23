// CatCut v2 — S2 timeline: Roles.
//
// FCP-style organisation (architecture doc section 7, research doc
// section 1): clips are organised by *content type* (role), not by
// track number. Audio lanes are laid out per role, and S4 exports
// stems per role. Four built-in roles exist; the user can add custom
// ones. A role is just a name — the model never hard-codes a lane
// number for a role, lanes are derived from the roles actually in use
// (see TimelineModel::computeLanes).

#pragma once

#include <QList>
#include <QString>

namespace catcut {

// Built-in role names. Stored as QString so custom roles are the same
// type; compare by value, never by pointer.
namespace RoleNames {
inline const QString kDialogue = QStringLiteral("对白");
inline const QString kMusic = QStringLiteral("音乐");
inline const QString kSfx = QStringLiteral("音效");
inline const QString kTitle = QStringLiteral("标题");
} // namespace RoleNames

// Registry of known roles: the four built-ins in canonical lane order,
// then any custom roles in registration order. Lane order is the
// registration order — that is what makes lane layout deterministic.
class RoleRegistry {
public:
    RoleRegistry();

    // All roles in lane order (built-ins first).
    const QList<QString>& roles() const { return m_roles; }

    // Index of `role` in lane order, or -1 when unknown. Unknown roles
    // are *not* silently invented here; TimelineModel registers them
    // explicitly when a clip arrives with a new role name.
    int indexOf(const QString& role) const { return m_roles.indexOf(role); }

    // Adds a custom role (no-op when it already exists, including the
    // built-ins). Returns its lane index. Empty names are refused.
    int addCustomRole(const QString& role);

    bool isBuiltIn(const QString& role) const;
    static bool isValidRoleName(const QString& role);

private:
    QList<QString> m_roles;
};

// Default role for a fresh clip of a given kind.
QString defaultRoleForKind(const QString& kind);

} // namespace catcut
