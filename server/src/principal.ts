import type { FastifyRequest } from 'fastify'

export function principalKeys(req: FastifyRequest) {
  const keys = new Set<string>()
  const principal = (req as any).principal as string | undefined
  const oid = (req as any).oid as string | undefined
  const tid = (req as any).tid as string | undefined
  const groups = ((req as any).groups ?? []) as string[]

  if (oid) keys.add(`oid:${oid}`)
  if (tid && oid) keys.add(`tenant:${tid}:oid:${oid}`)
  if (principal) keys.add(`principal:${principal.toLowerCase()}`)
  for (const group of groups) {
    if (group) keys.add(`group:${group}`)
  }

  return [...keys]
}

export function displayPrincipal(req: FastifyRequest) {
  return String((req as any).principal ?? (req as any).oid ?? 'unknown')
}
