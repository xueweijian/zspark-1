import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { pool } from './db.js'
import { displayPrincipal } from './principal.js'
import { canAccessWorkspace } from './workspaces.js'

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const MAX_ARTIFACT_BODY_BYTES = 70 * 1024 * 1024

interface ArtifactEnv {
  ZSPARK_ARTIFACT_STORAGE_DIR?: string
}

interface ArtifactParams {
  workspaceId: string
  sessionId: string
  artifactId?: string
}

const UploadArtifactBody = z.object({
  name: z.string().max(180).optional(),
  mimeType: z.string().max(200).optional(),
  localPath: z.string().max(1000).optional(),
  turnId: z.string().max(120).optional(),
  contentBase64: z.string().min(1)
})

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'artifact'
}

function storageRoot(env: ArtifactEnv) {
  return resolve(env.ZSPARK_ARTIFACT_STORAGE_DIR || join(process.cwd(), 'data', 'artifacts'))
}

function isInsidePath(root: string, candidate: string) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

async function writeArtifactFile(root: string, id: string, content: Buffer) {
  const filePath = join(root, id.slice(0, 2), id)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, { mode: 0o600 })
  return filePath
}

function decodeBase64Strict(value: string) {
  if (!BASE64_RE.test(value)) return null
  return Buffer.from(value, 'base64')
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

export async function registerArtifactRoutes(app: FastifyInstance, env: ArtifactEnv = {}) {
  const root = storageRoot(env)

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

  app.post('/workspaces/:workspaceId/sessions/:sessionId/artifacts', { bodyLimit: MAX_ARTIFACT_BODY_BYTES }, async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'database unavailable' })
    const { workspaceId, sessionId } = req.params as ArtifactParams
    if (!(await ensureArtifactAccess(req, workspaceId, sessionId))) {
      return reply.code(403).send({ error: 'workspace forbidden' })
    }

    const parsed = UploadArtifactBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid artifact payload', detail: parsed.error.flatten() })
    const body = parsed.data

    let content: Buffer
    const decoded = decodeBase64Strict(body.contentBase64)
    if (!decoded) {
      return reply.code(400).send({ error: 'contentBase64 is not valid base64' })
    }
    content = decoded
    if (!content.length) return reply.code(400).send({ error: 'artifact is empty' })
    if (content.length > MAX_ARTIFACT_BYTES) {
      return reply.code(413).send({ error: 'artifact too large', limit: MAX_ARTIFACT_BYTES })
    }

    const id = randomUUID()
    const name = safeFileName(body.name?.trim() || 'artifact')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const storagePath = await writeArtifactFile(root, id, content)
    let result
    try {
      result = await pool.query(
        `
          INSERT INTO artifacts (
            id, workspace_id, session_id, created_by, name, mime_type,
            size_bytes, sha256, local_path, turn_id, storage_path, content
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)
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
          body.localPath || null,
          body.turnId || null,
          storagePath
        ]
      )
    } catch (err) {
      // Avoid orphan files on disk if the row insert fails.
      await unlink(storagePath).catch(() => {})
      throw err
    }
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
        SELECT name, mime_type, content, storage_path
        FROM artifacts
        WHERE id = $1 AND workspace_id = $2 AND session_id = $3
        LIMIT 1
      `,
      [artifactId, workspaceId, sessionId]
    )
    if (!result.rowCount) return reply.code(404).send({ error: 'artifact not found' })
    const row = result.rows[0]
    const fileName = safeFileName(row.name)
    const response = reply
      .header('content-type', row.mime_type || 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${fileName}"`)
    if (row.storage_path) {
      const filePath = resolve(row.storage_path)
      if (!isInsidePath(root, filePath)) return reply.code(500).send({ error: 'artifact storage path is invalid' })
      if (!existsSync(filePath)) return reply.code(404).send({ error: 'artifact file is missing' })
      return response.send(createReadStream(filePath))
    }
    if (row.content) return response.send(row.content)
    return reply.code(404).send({ error: 'artifact content is missing' })
  })
}
