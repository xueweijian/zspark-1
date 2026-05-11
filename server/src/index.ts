import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import cors from '@fastify/cors'
import { z } from 'zod'
import { registerCollabRoutes } from './collab.js'
import { registerAuthRoutes } from './auth.js'
import { registerTeamsRoutes } from './teams.js'
import { initDb } from './db.js'
import { entraAuth } from './entra.js'

const Env = z.object({
  PORT: z.string().default('8787'),
  DATABASE_URL: z.string().default('postgres://zspark:zspark@localhost:5432/zspark'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ZSPARK_TENANT_ID: z.string().optional(),
  ZSPARK_CLIENT_ID: z.string().optional(),
  ZSPARK_AUTHORITY: z.string().optional(),
  TEAMS_BOT_APP_ID: z.string().optional(),
  TEAMS_BOT_APP_SECRET: z.string().optional()
})

const env = Env.parse(process.env)

async function main() {
  await initDb(env.DATABASE_URL)
  const app = Fastify({ logger: { level: 'info' } })
  await app.register(cors, { origin: true, credentials: true })
  await app.register(websocket)

  app.addHook('onRequest', entraAuth(env))

  app.get('/healthz', async () => ({ ok: true, service: 'zspark-server' }))

  await registerAuthRoutes(app)
  await registerCollabRoutes(app)
  await registerTeamsRoutes(app, env)

  const port = Number(env.PORT)
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`zspark-server listening on :${port}`)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
