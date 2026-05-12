import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { pool } from './db.js'
import { displayPrincipal, principalKeys } from './principal.js'
import { canAccessWorkspace } from './workspaces.js'

interface SessionParams {
  workspaceId: string
  sessionId?: string
}

interface CreateSessionBody {
  title?: string
  localThreadId?: string
  snapshot?: unknown
}

interface UpdateSessionBody {
  title?: string
  localThreadId?: string | null
  snapshot?: unknown
}

async function ensureWorkspaceAccess(req: FastifyRequest, workspaceId: string) {
  return canAccessWorkspace(req, workspaceId)
}

function sessionTitle(rawTitle: unknown, req: FastifyRequest) {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  return (title || `${displayPrincipal(req)} shared chat`).slice(0, 160)
}

async function sessionBelongsToWorkspace(sessionId: string, workspaceId: string) {
  if (!pool) return false
  const result = await pool.query(
    'SELECT 1 FROM sessions WHERE id = $1 AND workspace_id = $2 LIMIT 1',
    [sessionId, workspaceId]
  )
  return Boolean(result.rowCount)
}

async function latestSnapshot(sessionId: string) {
  if (!pool) return null
  const result = await pool.query(
    `
      SELECT content
      FROM messages
      WHERE session_id = $1 AND role = 'snapshot'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [sessionId]
  )
  return result.rows[0]?.content ?? null
}

async function writeSnapshot(sessionId: string, snapshot: unknown) {
  if (!pool || snapshot === undefined) return
  await pool.query(
    `
      INSERT INTO messages (session_id, role, content)
      VALUES ($1, 'snapshot', $2::jsonb)
    `,
    [sessionId, JSON.stringify(snapshot)]
  )
}

export async function registerSessionRoutes(app: FastifyInstance) {
  app.get('/workspaces/:workspaceId/sessions', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId } = req.params as SessionParams
    if (!(await ensureWorkspaceAccess(req, workspaceId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }
    const result = await pool.query(
      `
        SELECT id, owner, title, local_thread_id, created_at, updated_at
        FROM sessions
        WHERE workspace_id = $1
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 100
      `,
      [workspaceId]
    )
    return { sessions: result.rows }
  })

  app.post('/workspaces/:workspaceId/sessions', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId } = req.params as SessionParams
    if (!(await ensureWorkspaceAccess(req, workspaceId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }
    const keys = principalKeys(req)
    const owner = keys[0]
    if (!owner) return reply.code(401).send({ error: 'unauthenticated' })

    const body = (req.body ?? {}) as CreateSessionBody
    const id = randomUUID()
    const result = await pool.query(
      `
        INSERT INTO sessions (id, owner, title, workspace_id, local_thread_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        RETURNING id, owner, title, local_thread_id, created_at, updated_at
      `,
      [id, owner, sessionTitle(body.title, req), workspaceId, body.localThreadId ?? null]
    )
    await writeSnapshot(id, body.snapshot)
    return reply.code(201).send({ session: result.rows[0] })
  })

  app.get('/workspaces/:workspaceId/sessions/:sessionId', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId, sessionId } = req.params as SessionParams
    if (!sessionId || !(await ensureWorkspaceAccess(req, workspaceId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }
    if (!(await sessionBelongsToWorkspace(sessionId, workspaceId))) {
      return reply.code(404).send({ error: 'session not found' })
    }
    const result = await pool.query(
      `
        SELECT id, owner, title, local_thread_id, created_at, updated_at
        FROM sessions
        WHERE id = $1 AND workspace_id = $2
      `,
      [sessionId, workspaceId]
    )
    return { session: result.rows[0], snapshot: await latestSnapshot(sessionId) }
  })

  app.patch('/workspaces/:workspaceId/sessions/:sessionId', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId, sessionId } = req.params as SessionParams
    if (!sessionId || !(await ensureWorkspaceAccess(req, workspaceId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }
    if (!(await sessionBelongsToWorkspace(sessionId, workspaceId))) {
      return reply.code(404).send({ error: 'session not found' })
    }
    const body = (req.body ?? {}) as UpdateSessionBody
    const title = body.title === undefined ? null : sessionTitle(body.title, req)
    const hasTitle = body.title !== undefined
    const hasLocalThreadId = body.localThreadId !== undefined
    const result = await pool.query(
      `
        UPDATE sessions
        SET
          title = CASE WHEN $3::boolean THEN $4 ELSE title END,
          local_thread_id = CASE WHEN $5::boolean THEN $6 ELSE local_thread_id END,
          updated_at = now()
        WHERE id = $1 AND workspace_id = $2
        RETURNING id, owner, title, local_thread_id, created_at, updated_at
      `,
      [sessionId, workspaceId, hasTitle, title, hasLocalThreadId, body.localThreadId ?? null]
    )
    await writeSnapshot(sessionId, body.snapshot)
    return { session: result.rows[0] }
  })

  app.delete('/workspaces/:workspaceId/sessions/:sessionId', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId, sessionId } = req.params as SessionParams
    if (!sessionId || !(await ensureWorkspaceAccess(req, workspaceId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }
    await pool.query('DELETE FROM sessions WHERE id = $1 AND workspace_id = $2', [sessionId, workspaceId])
    return reply.code(204).send()
  })
}
