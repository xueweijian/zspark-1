import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { pool } from './db.js'
import { displayPrincipal } from './principal.js'
import { canAccessWorkspace } from './workspaces.js'

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

interface ArtifactParams {
  workspaceId: string
  sessionId: string
  artifactId?: string
}

interface UploadArtifactBody {
  name?: string
  mimeType?: string
  localPath?: string
  turnId?: string
  contentBase64?: string
}

function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'artifact'
}

function artifactMetadata(row: any) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    name: row.name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    local_path: row.local_path,
    turn_id: row.turn_id,
    created_at: row.created_at
  }
}

async function sessionBelongsToWorkspace(sessionId: string, workspaceId: string) {
  if (!pool) return false
  const result = await pool.query(
    'SELECT 1 FROM sessions WHERE id = $1 AND workspace_id = $2 LIMIT 1',
    [sessionId, workspaceId]
  )
  return Boolean(result.rowCount)
}

async function ensureArtifactAccess(req: FastifyRequest, workspaceId: string, sessionId: string) {
  return (await canAccessWorkspace(req, workspaceId)) && (await sessionBelongsToWorkspace(sessionId, workspaceId))
}

export async function registerArtifactRoutes(app: FastifyInstance) {
  app.get('/workspaces/:workspaceId/sessions/:sessionId/artifacts', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId, sessionId } = req.params as ArtifactParams
    if (!(await ensureArtifactAccess(req, workspaceId, sessionId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }
    const result = await pool.query(
      `
        SELECT id, workspace_id, session_id, name, mime_type, size_bytes, sha256, local_path, turn_id, created_at
        FROM artifacts
        WHERE workspace_id = $1 AND session_id = $2
        ORDER BY created_at DESC
        LIMIT 100
      `,
      [workspaceId, sessionId]
    )
    return { artifacts: result.rows.map(artifactMetadata) }
  })

  app.post('/workspaces/:workspaceId/sessions/:sessionId/artifacts', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId, sessionId } = req.params as ArtifactParams
    if (!(await ensureArtifactAccess(req, workspaceId, sessionId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }

    const body = (req.body ?? {}) as UploadArtifactBody
    if (!body.contentBase64 || typeof body.contentBase64 !== 'string') {
      return reply.code(400).send({ error: 'contentBase64 is required' })
    }

    let content: Buffer
    try {
      content = Buffer.from(body.contentBase64, 'base64')
    } catch {
      return reply.code(400).send({ error: 'contentBase64 is not valid base64' })
    }
    if (!content.length) return reply.code(400).send({ error: 'artifact is empty' })
    if (content.length > MAX_ARTIFACT_BYTES) {
      return reply.code(413).send({ error: 'artifact too large', limit: MAX_ARTIFACT_BYTES })
    }

    const id = randomUUID()
    const name = safeFileName(body.name?.trim() || 'artifact')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const result = await pool.query(
      `
        INSERT INTO artifacts (
          id, workspace_id, session_id, created_by, name, mime_type,
          size_bytes, sha256, local_path, turn_id, content
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, workspace_id, session_id, name, mime_type, size_bytes, sha256, local_path, turn_id, created_at
      `,
      [
        id,
        workspaceId,
        sessionId,
        displayPrincipal(req),
        name,
        body.mimeType?.trim() || null,
        content.length,
        sha256,
        body.localPath?.slice(0, 1000) || null,
        body.turnId?.slice(0, 120) || null,
        content
      ]
    )
    await pool.query('UPDATE sessions SET updated_at = now() WHERE id = $1 AND workspace_id = $2', [sessionId, workspaceId])
    await pool.query('UPDATE workspaces SET updated_at = now() WHERE id = $1', [workspaceId])
    return reply.code(201).send({ artifact: artifactMetadata(result.rows[0]) })
  })

  app.get('/workspaces/:workspaceId/sessions/:sessionId/artifacts/:artifactId/download', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId, sessionId, artifactId } = req.params as ArtifactParams
    if (!artifactId || !(await ensureArtifactAccess(req, workspaceId, sessionId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }
    const result = await pool.query(
      `
        SELECT name, mime_type, content
        FROM artifacts
        WHERE id = $1 AND workspace_id = $2 AND session_id = $3
        LIMIT 1
      `,
      [artifactId, workspaceId, sessionId]
    )
    if (!result.rowCount) return reply.code(404).send({ error: 'artifact not found' })
    const row = result.rows[0]
    const fileName = safeFileName(row.name)
    return reply
      .header('content-type', row.mime_type || 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${fileName}"`)
      .send(row.content)
  })
}
