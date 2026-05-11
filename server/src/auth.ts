import type { FastifyInstance } from 'fastify'

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get('/auth/whoami', async (req) => ({
    principal: (req as any).principal ?? null,
    oid: (req as any).oid ?? null,
    tid: (req as any).tid ?? null
  }))

  app.post('/auth/handshake', async (req) => ({
    ok: true,
    principal: (req as any).principal ?? null
  }))
}
