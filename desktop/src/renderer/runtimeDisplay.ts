export function shortPath(path?: string, maxLength = 42): string {
  if (!path) return '—'
  if (path.length <= maxLength) return path
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return `…${path.slice(-(maxLength - 1))}`
  const tail = parts.slice(-2).join('/')
  return tail.length + 2 <= maxLength ? `…/${tail}` : `…${path.slice(-(maxLength - 1))}`
}

export function formatApprovalPolicy(policy: unknown): string {
  if (!policy) return '—'
  if (typeof policy === 'string') return titleize(policy)
  if (typeof policy === 'object') {
    const keys = Object.keys(policy as Record<string, unknown>)
    if (keys.length === 1) return titleize(keys[0])
    return 'Granular'
  }
  return String(policy)
}

export function formatSandboxPolicy(policy: any, permissionProfile?: any): string {
  if (permissionProfile?.type === 'disabled') return 'Disabled'
  if (!policy) {
    if (permissionProfile?.type === 'managed') return formatManagedPermissionProfile(permissionProfile)
    if (permissionProfile?.type === 'external') return `External${networkSuffix(permissionProfile.network?.enabled)}`
    return '—'
  }

  switch (policy.type) {
    case 'dangerFullAccess':
      return 'Danger full access'
    case 'readOnly':
      return `Read only${networkSuffix(policy.networkAccess)}`
    case 'workspaceWrite':
      return `Workspace write${networkSuffix(policy.networkAccess)}`
    case 'externalSandbox':
      return `External sandbox${networkSuffix(policy.networkAccess === 'enabled')}`
    default:
      return titleize(String(policy.type ?? policy))
  }
}

function formatManagedPermissionProfile(permissionProfile: any): string {
  const fileSystem = permissionProfile.fileSystem
  const fs = fileSystem?.type === 'unrestricted' ? 'Unrestricted files' : 'Managed files'
  return `${fs}${networkSuffix(permissionProfile.network?.enabled)}`
}

function networkSuffix(enabled: unknown): string {
  if (enabled === true) return ' + network'
  if (enabled === false) return ' · no network'
  return ''
}

function titleize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}
