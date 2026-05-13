import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import cors from '@fastify/cors'
import { z } from 'zod'
import { registerCollabRoutes } from './collab.js'
import { registerAuthRoutes } from './auth.js'
import { registerTeamsRoutes } from './teams.js'
import { initDb } from './db.js'
import { entraAuth } from './entra.js'
import { registerWorkspaceRoutes } from './workspaces.js'
import { registerSessionRoutes } from './sessions.js'
import { registerArtifactRoutes } from './artifacts.js'
import { registerRateLimit } from './rateLimit.js'

const Env = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.string().default('8787'),
  DATABASE_URL: z.string().default('postgres://zspark:zspark@localhost:5432/zspark'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ZSPARK_TENANT_ID: z.string().optional(),
  ZSPARK_CLIENT_ID: z.string().optional(),
  ZSPARK_AUTHORITY: z.string().optional(),
  ZSPARK_CORS_ORIGINS: z.string().optional(),
  ZSPARK_RATE_LIMIT_WINDOW_MS: z.string().optional(),
  ZSPARK_RATE_LIMIT_MAX: z.string().optional(),
  ZSPARK_ARTIFACT_STORAGE_DIR: z.string().optional(),
  TEAMS_BOT_APP_ID: z.string().optional(),
  TEAMS_BOT_APP_SECRET: z.string().optional(),
  TEAMS_WEBHOOK_ALLOWED_HOSTS: z.string().optional()
})

const env = Env.parse(process.env)

async function main() {
  await initDb(env.DATABASE_URL)
  const app = Fastify({
    logger: {
      level: 'info',
      serializers: {
        req(req: any) {
          return {
            method: req.method,
            url: scrubRequestUrl(req.url),
            host: req.host,
            remoteAddress: req.ip,
            remotePort: req.socket?.remotePort
          }
        }
      }
    },
    bodyLimit: 10 * 1024 * 1024
  })
  await app.register(cors, { origin: corsOrigin(env), credentials: true })
  await app.register(websocket)

  registerRateLimit(app, env)
  app.addHook('onRequest', entraAuth(env))

  app.get('/healthz', async () => ({ ok: true, service: 'zspark-server' }))

  await registerAuthRoutes(app)
  await registerWorkspaceRoutes(app)
  await registerSessionRoutes(app)
  await registerArtifactRoutes(app, env)
  await registerCollabRoutes(app)
  await registerTeamsRoutes(app, env)

  const port = Number(env.PORT)
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`zspark-server listening on :${port}`)
}

function csv(value?: string) {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
}

function corsOrigin(env: z.infer<typeof Env>) {
  const allowedOrigins = csv(env.ZSPARK_CORS_ORIGINS)
  if (env.NODE_ENV === 'development' && allowedOrigins.length === 0) return true
  return async (origin: string | undefined) => !origin || allowedOrigins.includes(origin)
}

function scrubRequestUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl, 'http://zspark.local')
    if (parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', '[redacted]')
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return rawUrl.replace(/([?&]access_token=)[^&\s]+/gi, '$1[redacted]')
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
