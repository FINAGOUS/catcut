#include "core/Roles.h"

namespace catcut {

RoleRegistry::RoleRegistry()
{
    m_roles = { RoleNames::kDialogue, RoleNames::kMusic, RoleNames::kSfx,
                RoleNames::kTitle };
}

int RoleRegistry::addCustomRole(const QString& role)
{
    if (!isValidRoleName(role))
        return -1;
    const int existing = m_roles.indexOf(role);
    if (existing >= 0)
        return existing;
    m_roles.append(role);
    return m_roles.size() - 1;
}

bool RoleRegistry::isBuiltIn(const QString& role) const
{
    return role == RoleNames::kDialogue || role == RoleNames::kMusic
        || role == RoleNames::kSfx || role == RoleNames::kTitle;
}

bool RoleRegistry::isValidRoleName(const QString& role)
{
    return !role.trimmed().isEmpty();
}

QString defaultRoleForKind(const QString& kind)
{
    if (kind == QStringLiteral("audio"))
        return RoleNames::kDialogue;
    if (kind == QStringLiteral("title"))
        return RoleNames::kTitle;
    return RoleNames::kDialogue;
}

} // namespace catcut
