import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { pool } from './db.js'
import { displayPrincipal, principalKeys } from './principal.js'

const CreateWorkspaceBody = z.object({
  name: z.string().trim().min(1).max(120).optional()
})

export async function canAccessWorkspace(req: FastifyRequest, workspaceId: string) {
  const keys = principalKeys(req)
  if (!pool || keys.length === 0) return false
  const cache = ((req as any)._workspaceAccessCache ??= new Map<string, boolean>()) as Map<string, boolean>
  const cacheKey = `${workspaceId}:${keys.join('\0')}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached
  const result = await pool.query(
    `
      SELECT 1
      FROM workspaces w
      LEFT JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE w.id = $1
        AND (w.owner_key = ANY($2::text[]) OR wm.principal_key = ANY($2::text[]))
      LIMIT 1
    `,
    [workspaceId, keys]
  )
  const allowed = Boolean(result.rowCount)
  cache.set(cacheKey, allowed)
  return allowed
}

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.get('/workspaces', async (req) => {
    const keys = principalKeys(req)
    if (!pool || keys.length === 0) return { workspaces: [] }
    const result = await pool.query(
      `
        SELECT DISTINCT w.id, w.name, w.owner_key, w.created_at, w.updated_at
        FROM workspaces w
        LEFT JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE w.owner_key = ANY($1::text[]) OR wm.principal_key = ANY($1::text[])
        ORDER BY w.updated_at DESC
      `,
      [keys]
    )
    return { workspaces: result.rows }
  })

  app.post('/workspaces', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const keys = principalKeys(req)
    const ownerKey = keys[0]
    if (!ownerKey) return reply.code(401).send({ error: 'unauthenticated' })

    const parsed = CreateWorkspaceBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid workspace payload', detail: parsed.error.flatten() })
    const body = parsed.data
    const id = randomUUID()
    const name = body.name || `${displayPrincipal(req)} shared workspace`

    const result = await pool.query(
      `
        INSERT INTO workspaces (id, name, owner_key)
        VALUES ($1, $2, $3)
        RETURNING id, name, owner_key, created_at, updated_at
      `,
      [id, name, ownerKey]
    )
    await pool.query(
      `
        INSERT INTO workspace_members (workspace_id, principal_key, role)
        VALUES ($1, $2, 'owner')
        ON CONFLICT (workspace_id, principal_key) DO UPDATE SET role = EXCLUDED.role
      `,
      [id, ownerKey]
    )
    return reply.code(201).send({ workspace: result.rows[0] })
  })

  app.get('/workspaces/:id', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const id = (req.params as { id: string }).id
    const allowed = await canAccessWorkspace(req, id)
    if (!allowed) return reply.code(403).send({ error: 'workspace forbidden' })
    const result = await pool.query(
      'SELECT id, name, owner_key, created_at, updated_at FROM workspaces WHERE id = $1',
      [id]
    )
    if (!result.rowCount) return reply.code(404).send({ error: 'workspace not found' })
    return { workspace: result.rows[0] }
  })
}
