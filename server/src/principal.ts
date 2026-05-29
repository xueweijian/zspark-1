import type { FastifyRequest } from 'fastify'
import type { AuthenticatedRequest } from './types.js'

export function principalKeys(req: FastifyRequest): string[] {
  const keys = new Set<string>()
  const authReq = req as AuthenticatedRequest
  const principal = authReq.principal
  const oid = authReq.oid
  const tid = authReq.tid
  const groups = authReq.groups ?? []

  if (oid) keys.add(`oid:${oid}`)
  if (tid && oid) keys.add(`tenant:${tid}:oid:${oid}`)
  if (principal) keys.add(`principal:${principal.toLowerCase()}`)
  for (const group of groups) {
    if (group) keys.add(`group:${group}`)
  }

  return [...keys]
}

export function displayPrincipal(req: FastifyRequest): string {
  const authReq = req as AuthenticatedRequest
  return String(authReq.principal ?? authReq.oid ?? 'unknown')
}
