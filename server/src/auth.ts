import type { FastifyInstance } from 'fastify'
import type { AuthenticatedRequest } from './types.js'

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get('/auth/whoami', async (req) => {
    const authReq = req as AuthenticatedRequest
    return {
      principal: authReq.principal ?? null,
      oid: authReq.oid ?? null,
      tid: authReq.tid ?? null
    }
  })

  app.post('/auth/handshake', async (req) => {
    const authReq = req as AuthenticatedRequest
    return {
      ok: true,
      principal: authReq.principal ?? null
    }
  })
}
