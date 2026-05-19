import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { pool } from './db.js'
import { displayPrincipal, principalKeys } from './principal.js'
import { canAccessWorkspace } from './workspaces.js'

interface SessionParams {
  workspaceId: string
  sessionId?: string
}

class SnapshotConflictError extends Error {
  constructor(readonly revision: number | null) {
    super('shared session snapshot changed')
  }
}

const JsonRpcIdSchema = z.union([z.string().max(200), z.number()])
const ActivityKindSchema = z.enum(['reasoning', 'command', 'file', 'tool', 'web', 'memory'])
const ActivityActionKindSchema = z.enum(['read', 'write', 'list', 'search', 'run', 'build', 'verify', 'tool', 'file'])
const ActivitySchema = z.object({
  id: z.string().max(240),
  kind: ActivityKindSchema,
  title: z.string().max(500),
  detail: z.string().max(6000).optional(),
  actionKind: ActivityActionKindSchema.optional(),
  target: z.string().max(1200).optional(),
  status: z.enum(['running', 'done', 'failed']),
  startedAt: z.number(),
  endedAt: z.number().optional()
}).strict()

const WorkspaceFileSchema = z.object({
  id: z.string().max(240),
  name: z.string().max(240),
  path: z.string().max(1400),
  source: z.enum(['attachment', 'change']),
  status: z.enum(['attached', 'created', 'modified', 'deleted', 'missing']),
  detail: z.string().max(1000).optional(),
  updatedAt: z.number(),
  sharedArtifact: z.object({
    workspaceId: z.string().max(160),
    sessionId: z.string().max(160),
    artifactId: z.string().max(160),
    sizeBytes: z.number().optional()
  }).strict().optional()
}).strict()

// Cap raw approval params: codex can stash arbitrarily-large objects under
// `request.params` (full command output, file diffs, …). Persisting them
// untrimmed lets a peer balloon the snapshot until the body limit kicks in,
// killing every subsequent PATCH silently. Re-stringify with a hard ceiling.
const ApprovalParamsSchema = z.unknown().transform((value) => {
  if (value === undefined) return undefined
  try {
    const json = JSON.stringify(value)
    if (json.length <= 32_000) return value
    return { truncated: true, preview: json.slice(0, 32_000) }
  } catch {
    return undefined
  }
})

const ApprovalRequestSchema = z.object({
  id: JsonRpcIdSchema,
  key: z.string().max(240),
  kind: z.enum(['command', 'fileChange', 'permissions']),
  method: z.string().max(160),
  blockId: z.string().max(240),
  threadId: z.string().max(240),
  turnId: z.string().max(240),
  itemId: z.string().max(240),
  title: z.string().max(500),
  description: z.string().max(1000),
  detail: z.string().max(3000).optional(),
  commandPreview: z.string().max(3000).optional(),
  cwd: z.string().max(1200).optional(),
  reason: z.string().max(1000).optional(),
  paths: z.array(z.string().max(1200)).max(200),
  params: ApprovalParamsSchema.optional(),
  status: z.enum(['pending', 'sending', 'approved', 'approvedAll', 'denied', 'resolved']),
  startedAt: z.number()
}).strict()

const TurnBlockStatusSchema = z.enum(['running', 'completed', 'interrupted', 'failed'])

const TurnInputTextElementSchema = z.unknown()
const TurnInputItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().max(200_000),
    textElements: z.array(TurnInputTextElementSchema).max(200).optional(),
    text_elements: z.array(TurnInputTextElementSchema).max(200).optional()
  }).strict(),
  z.object({
    type: z.literal('image'),
    url: z.string().max(4000)
  }).strict(),
  z.object({
    type: z.literal('localImage'),
    path: z.string().max(1400)
  }).strict(),
  z.object({
    type: z.literal('skill'),
    name: z.string().max(240),
    path: z.string().max(1400)
  }).strict(),
  z.object({
    type: z.literal('mention'),
    name: z.string().max(240),
    path: z.string().max(1400)
  }).strict()
])

const SnapshotBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    id: z.string().max(240),
    text: z.string().max(200_000),
    turnId: z.string().max(240).optional(),
    input: z.array(TurnInputItemSchema).max(200).optional()
  }).strict(),
  z.object({
    type: z.literal('agent'),
    id: z.string().max(240),
    text: z.string().max(1_000_000),
    turnId: z.string().max(240).optional(),
    memoryCitation: z.unknown().optional().nullable()
  }).strict(),
  z.object({
    type: z.literal('files'),
    id: z.string().max(240),
    turnId: z.string().max(240),
    title: z.string().max(500),
    files: z.array(WorkspaceFileSchema).max(300),
    subtitle: z.string().max(1000).optional(),
    tone: z.enum(['normal', 'warn']).optional()
  }).strict(),
  z.object({
    type: z.literal('approval'),
    id: z.string().max(240),
    turnId: z.string().max(240),
    request: ApprovalRequestSchema
  }).strict(),
  z.object({
    type: z.literal('turn'),
    id: z.string().max(240),
    turnId: z.string().max(240),
    activities: z.array(ActivitySchema).max(1000),
    collapsed: z.boolean(),
    finalMessageId: z.string().max(240).optional(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    status: TurnBlockStatusSchema.optional()
  }).strict()
])

const SharedSessionSnapshotSchema = z.object({
  version: z.number().optional(),
  title: z.string().max(160).optional(),
  localThreadId: z.string().max(160).nullable().optional(),
  blocks: z.array(SnapshotBlockSchema).max(800).optional(),
  artifacts: z.array(z.unknown()).max(200).optional(),
  updatedAt: z.number().optional(),
  revision: z.number().nullable().optional()
}).strict()

const CreateSessionBody = z.object({
  title: z.string().max(160).optional(),
  localThreadId: z.string().max(160).optional(),
  snapshot: SharedSessionSnapshotSchema.optional()
})

const UpdateSessionBody = z.object({
  title: z.string().max(160).optional(),
  localThreadId: z.string().max(160).nullable().optional(),
  snapshot: SharedSessionSnapshotSchema.optional(),
  baseRevision: z.number().nullable().optional()
})

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

function snapshotWithRevision(content: unknown, revision: number) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  return { ...content, revision }
}

async function latestSnapshot(sessionId: string) {
  if (!pool) return null
  const result = await pool.query(
    `
      SELECT id, content
      FROM messages
      WHERE session_id = $1 AND role = 'snapshot'
      ORDER BY id DESC
      LIMIT 1
    `,
    [sessionId]
  )
  const row = result.rows[0]
  return row ? snapshotWithRevision(row.content, Number(row.id)) : null
}

async function latestSnapshotRevision(client: PoolClient, sessionId: string) {
  const result = await client.query(
    `
      SELECT id
      FROM messages
      WHERE session_id = $1 AND role = 'snapshot'
      ORDER BY id DESC
      LIMIT 1
    `,
    [sessionId]
  )
  return result.rows[0]?.id == null ? null : Number(result.rows[0].id)
}

async function writeSnapshot(client: PoolClient, sessionId: string, snapshot: z.infer<typeof SharedSessionSnapshotSchema> | undefined, baseRevision?: number | null) {
  if (snapshot === undefined) return null
  await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sessionId])
  const currentRevision = await latestSnapshotRevision(client, sessionId)
  // Treat `null` and `undefined` as "no prior revision known" so a freshly
  // opened session whose client never received a revision yet doesn't 409
  // on its first PATCH. Conflict only when both sides have a revision and
  // the numbers disagree.
  const baseAdvertised = baseRevision === undefined ? null : baseRevision
  const conflict = baseRevision !== undefined &&
    !(baseAdvertised === null && currentRevision === null) &&
    baseAdvertised !== currentRevision
  if (conflict) {
    throw new SnapshotConflictError(currentRevision)
  }
  const content = { ...snapshot }
  delete content.revision
  const result = await client.query(
    `
      INSERT INTO messages (session_id, role, content)
      VALUES ($1, 'snapshot', $2::jsonb)
      RETURNING id
    `,
    [sessionId, JSON.stringify(content)]
  )
  return Number(result.rows[0].id)
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

    const parsed = CreateSessionBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid session payload', detail: parsed.error.flatten() })
    const body = parsed.data
    const id = randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `
          INSERT INTO sessions (id, owner, title, workspace_id, local_thread_id, updated_at)
          VALUES ($1, $2, $3, $4, $5, now())
          RETURNING id, owner, title, local_thread_id, created_at, updated_at
        `,
        [id, owner, sessionTitle(body.title, req), workspaceId, body.localThreadId ?? null]
      )
      const snapshotRevision = await writeSnapshot(client, id, body.snapshot)
      await client.query('COMMIT')
      return reply.code(201).send({ session: result.rows[0], snapshotRevision })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
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
    const parsed = UpdateSessionBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid session payload', detail: parsed.error.flatten() })
    const body = parsed.data
    const title = body.title === undefined ? null : sessionTitle(body.title, req)
    const hasTitle = body.title !== undefined
    const hasLocalThreadId = body.localThreadId !== undefined
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
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
      const snapshotRevision = await writeSnapshot(client, sessionId, body.snapshot, body.baseRevision)
      await client.query('COMMIT')
      return { session: result.rows[0], snapshotRevision }
    } catch (err) {
      await client.query('ROLLBACK')
      if (err instanceof SnapshotConflictError) {
        return reply.code(409).send({ error: err.message, revision: err.revision })
      }
      throw err
    } finally {
      client.release()
    }
  })

  app.delete('/workspaces/:workspaceId/sessions/:sessionId', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId, sessionId } = req.params as SessionParams
    if (!sessionId || !(await ensureWorkspaceAccess(req, workspaceId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }
    const keys = principalKeys(req)
    if (keys.length === 0) return reply.code(401).send({ error: 'unauthenticated' })
    const deleted = await pool.query(
      `
        DELETE FROM sessions s
        USING workspaces w
        WHERE s.id = $1
          AND s.workspace_id = $2
          AND w.id = s.workspace_id
          AND (
            s.owner = ANY($3::text[])
            OR w.owner_key = ANY($3::text[])
            OR EXISTS (
              SELECT 1
              FROM workspace_members wm
              WHERE wm.workspace_id = w.id
                AND wm.principal_key = ANY($3::text[])
                AND wm.role = 'owner'
            )
          )
        RETURNING s.id
      `,
      [sessionId, workspaceId, keys]
    )
    if (!deleted.rowCount) return reply.code(403).send({ error: 'session delete forbidden' })
    return reply.code(204).send()
  })
}
