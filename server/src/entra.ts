import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'

interface EntraEnv {
  NODE_ENV?: string
  ZSPARK_TENANT_ID?: string
  ZSPARK_CLIENT_ID?: string
  ZSPARK_AUTHORITY?: string
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
let jwksUrl = ''

function getJwks(env: EntraEnv) {
  const nextJwksUrl = `${authorityBase(env)}/discovery/v2.0/keys`
  if (!jwks || jwksUrl !== nextJwksUrl) {
    jwks = createRemoteJWKSet(new URL(nextJwksUrl))
    jwksUrl = nextJwksUrl
  }
  return jwks
}

function issuer(env: EntraEnv) {
  return (
    env.ZSPARK_AUTHORITY ??
    `https://login.partner.microsoftonline.cn/${env.ZSPARK_TENANT_ID}/v2.0`
  ).replace(/\/+$/, '')
}

function authorityBase(env: EntraEnv) {
  return issuer(env).replace(/\/v2\.0$/i, '')
}

/**
 * Entra ID (Azure China) bearer-token middleware.
 *
 * - Skips exact /healthz and /teams/messages paths
 * - Verifies signature via JWKS at login.partner.microsoftonline.cn
 * - Validates `aud` against ZSPARK_CLIENT_ID and `iss` tenant
 * - Sets req.principal = upn|preferred_username|sub
 *
 * In development only, falls back to the X-Domain-User shim when Entra is not
 * configured, so contributors can boot the stack without Azure access.
 */
export function entraAuth(env: EntraEnv) {
  const enabled = Boolean(env.ZSPARK_TENANT_ID && env.ZSPARK_CLIENT_ID)
  const allowDevShim = env.NODE_ENV === 'development'

  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (isPublicPath(req.url)) {
      return
    }

    if (!enabled) {
      if (!allowDevShim) {
        reply.code(503).send({ error: 'Entra ID is not configured' })
        return reply
      }
      const principal = req.headers['x-domain-user']
      if (!principal) {
        reply.code(401).send({ error: 'unauthenticated', hint: 'set X-Domain-User in dev or configure Entra ID' })
        return reply
      }
      ;(req as any).principal = String(principal)
      return
    }

    const auth = req.headers['authorization']
    const urlToken = tokenFromQuery(req.url)
    if (urlToken && !allowQueryToken(req)) {
      reply.code(400).send({ error: 'access_token query parameter is only allowed for /collab websocket upgrades' })
      return reply
    }
    if (!auth?.toLowerCase().startsWith('bearer ') && !urlToken) {
      reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'missing bearer token' })
      return reply
    }
    const token = urlToken ?? auth!.slice(7).trim()

    try {
      const { payload } = await jwtVerify(token, getJwks(env), {
        audience: tokenAudiences(env),
        issuer: tokenIssuers(env),
        algorithms: ['RS256']
      })
      if (env.ZSPARK_TENANT_ID && payload['tid'] !== env.ZSPARK_TENANT_ID) {
        throw new Error('unexpected tenant id in access token')
      }
      ;(req as any).principal =
        (payload['upn'] as string) ??
        (payload['preferred_username'] as string) ??
        (payload.sub as string)
      ;(req as any).oid = payload['oid'] as string | undefined
      ;(req as any).tid = payload['tid'] as string | undefined
      ;(req as any).groups = Array.isArray(payload['groups']) ? payload['groups'] : []
    } catch (err: any) {
      req.log.warn({ detail: err?.message }, 'Entra token verification failed')
      reply.code(401).send({ error: 'token verification failed' })
      return reply
    }
  }
}

function requestPath(url: string) {
  try {
    return new URL(url, 'http://zspark.local').pathname
  } catch {
    return url.split('?')[0] ?? url
  }
}

function isPublicPath(url: string) {
  const path = requestPath(url)
  return path === '/healthz' || path === '/teams/messages'
}

function tokenIssuers(env: EntraEnv) {
  const issuers = new Set<string>([issuer(env)])
  if (env.ZSPARK_TENANT_ID) {
    issuers.add(`https://login.partner.microsoftonline.cn/${env.ZSPARK_TENANT_ID}/v2.0`)
    issuers.add(`https://sts.chinacloudapi.cn/${env.ZSPARK_TENANT_ID}/`)
  }
  return [...issuers]
}

function tokenAudiences(env: EntraEnv) {
  const clientId = env.ZSPARK_CLIENT_ID
  if (!clientId) return []
  return [clientId, `api://${clientId}`]
}

function tokenFromQuery(url: string) {
  try {
    const parsed = new URL(url, 'http://zspark.local')
    return parsed.searchParams.get('access_token')?.trim() || undefined
  } catch {
    return undefined
  }
}

function allowQueryToken(req: FastifyRequest) {
  return req.url.startsWith('/collab/') && String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
}
