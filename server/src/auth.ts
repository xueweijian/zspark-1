import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

/**
 * Real Kerberos / SPNEGO must be wired with `node-expose-sspi` (Win) or
 * `kerberos` npm + node-krb5. Production deployment will plug GSSAPI here.
 *
 * For dev we accept an `X-Domain-User` header as the authenticated principal
 * so the rest of the stack can be built and tested without a KDC.
 */
export function kerberosPlaceholder(_service: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/healthz') || req.url.startsWith('/auth/')) return
    const principal = req.headers['x-domain-user']
    if (!principal) {
      reply.code(401).header('WWW-Authenticate', 'Negotiate').send({ error: 'unauthenticated' })
      return reply
    }
    ;(req as any).principal = String(principal)
  }
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get('/auth/whoami', async (req) => {
    return { principal: (req as any).principal ?? null }
  })

  app.post('/auth/handshake', async (req) => {
    // Stub: returns the resolved domain principal back to the client.
    return { ok: true, principal: (req as any).principal ?? null }
  })
}
