import type { FastifyRequest } from 'fastify'

/**
 * Extended FastifyRequest with authentication properties populated by auth middleware.
 * These properties are set by the Entra ID authentication flow.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  /** User principal name (email) from the authentication token */
  principal?: string
  /** Azure AD Object ID - unique identifier for the user */
  oid?: string
  /** Azure AD Tenant ID */
  tid?: string
  /** Azure AD group memberships */
  groups?: string[]
  /** Workspace access cache for performance optimization */
  _workspaceAccessCache?: Map<string, boolean>
}

/**
 * Type guard to check if a request has authentication properties
 */
export function isAuthenticated(req: FastifyRequest): req is AuthenticatedRequest {
  const authReq = req as AuthenticatedRequest
  return Boolean(authReq.principal || authReq.oid)
}
