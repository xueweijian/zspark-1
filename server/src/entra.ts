import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'

interface EntraEnv {
  ZSPARK_TENANT_ID?: string
  ZSPARK_CLIENT_ID?: string
  ZSPARK_AUTHORITY?: string
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

function getJwks(env: EntraEnv) {
  if (jwks) return jwks
  const authority =
    env.ZSPARK_AUTHORITY ??
    `https://login.partner.microsoftonline.cn/${env.ZSPARK_TENANT_ID}/v2.0`
  jwks = createRemoteJWKSet(new URL(`${authority.replace(/\/+$/, '')}/discovery/v2.0/keys`))
  return jwks
}

/**
 * Entra ID (Azure China) bearer-token middleware.
 *
 * - Skips /healthz, /auth/* and /teams/messages (Bot Framework handles its own auth)
 * - Verifies signature via JWKS at login.partner.microsoftonline.cn
 * - Validates `aud` against ZSPARK_CLIENT_ID and `iss` tenant
 * - Sets req.principal = upn|preferred_username|sub
 *
 * Falls back to the X-Domain-User dev shim when Entra is not configured,
 * so contributors can boot the stack without Azure access.
 */
export function entraAuth(env: EntraEnv) {
  const enabled = Boolean(env.ZSPARK_TENANT_ID && env.ZSPARK_CLIENT_ID)

  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      req.url.startsWith('/healthz') ||
      req.url.startsWith('/auth/') ||
      req.url.startsWith('/teams/messages')
    ) {
      return
    }

    if (!enabled) {
      const principal = req.headers['x-domain-user']
      if (!principal) {
        reply.code(401).send({ error: 'unauthenticated', hint: 'set X-Domain-User in dev or configure Entra ID' })
        return reply
      }
      ;(req as any).principal = String(principal)
      return
    }

    const auth = req.headers['authorization']
    if (!auth?.toLowerCase().startsWith('bearer ')) {
      reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'missing bearer token' })
      return reply
    }
    const token = auth.slice(7).trim()

    try {
      const { payload } = await jwtVerify(token, getJwks(env), {
        audience: env.ZSPARK_CLIENT_ID,
        issuer: `https://login.partner.microsoftonline.cn/${env.ZSPARK_TENANT_ID}/v2.0`
      })
      ;(req as any).principal =
        (payload['upn'] as string) ??
        (payload['preferred_username'] as string) ??
        (payload.sub as string)
      ;(req as any).oid = payload['oid'] as string | undefined
      ;(req as any).tid = payload['tid'] as string | undefined
    } catch (err: any) {
      reply.code(401).send({ error: 'token verification failed', detail: err?.message })
      return reply
    }
  }
}
