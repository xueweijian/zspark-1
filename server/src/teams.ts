import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

interface TeamsEnv {
  TEAMS_BOT_APP_ID?: string
  TEAMS_BOT_APP_SECRET?: string
  TEAMS_WEBHOOK_ALLOWED_HOSTS?: string
}

const NotifyBody = z.object({
  webhookUrl: z.string().url(),
  text: z.string().min(1).max(20_000),
  activityId: z.string().max(200).optional()
})

const DEFAULT_WEBHOOK_HOSTS = ['*.webhook.office.com', '*.webhook.office365.com', 'outlook.office.com']
const DELIVERED_ID_LIMIT = 10_000
// LRU eviction order: a Set's insertion order lets us drop the oldest entry
// without flushing the entire dedupe history (which would otherwise re-open a
// replay window every time the limit was hit).
const deliveredActivityIds = new Set<string>()

function rememberDeliveredActivity(activityId: string) {
  deliveredActivityIds.add(activityId)
  while (deliveredActivityIds.size > DELIVERED_ID_LIMIT) {
    const oldest = deliveredActivityIds.values().next().value
    if (oldest === undefined) break
    deliveredActivityIds.delete(oldest)
  }
}

/**
 * Microsoft Teams integration entry points.
 *
 * v1 surface:
 *  - POST /teams/notify        : push card to a channel via incoming webhook
 *  - POST /teams/messages      : Bot Framework message endpoint (Activity)
 *  - GET  /teams/manifest.json : downloadable Teams app manifest
 *
 * Real adapter goes through `botbuilder` once tenant + bot registration is
 * done. Stubbed here to keep the surface stable.
 */
export async function registerTeamsRoutes(app: FastifyInstance, env: TeamsEnv) {
  app.post('/teams/notify', async (req, reply) => {
    const parsed = NotifyBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid notify payload', detail: parsed.error.flatten() })
    const { webhookUrl, text, activityId } = parsed.data
    const url = new URL(webhookUrl)
    if (!(await isAllowedWebhookUrl(url, env))) {
      return reply.code(403).send({ error: 'webhook host is not allowed' })
    }
    if (activityId && deliveredActivityIds.has(activityId)) {
      return { delivered: true, duplicate: true }
    }
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      // 'manual' prevents redirect-based SSRF where an allowlisted host
      // 302s to an internal address (e.g. 169.254.169.254 metadata).
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000)
    })
    if (activityId && r.ok) {
      rememberDeliveredActivity(activityId)
    }
    return { delivered: r.ok, status: r.status }
  })

  app.post('/teams/messages', async (_req, reply) => {
    if (!env.TEAMS_BOT_APP_ID) return { ok: false, reason: 'bot not configured' }
    // TODO: wire botbuilder ConnectorClient + adapter.processActivity
    return reply.code(501).send({ ok: false, reason: 'bot adapter is not wired yet' })
  })

  app.get('/teams/manifest.json', async () => ({
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
    manifestVersion: '1.16',
    id: env.TEAMS_BOT_APP_ID ?? '00000000-0000-0000-0000-000000000000',
    version: '0.0.1',
    name: { short: 'zspark', full: 'zspark workspace' },
    description: { short: 'AI co-work assistant', full: 'zspark in Microsoft Teams' },
    bots: env.TEAMS_BOT_APP_ID
      ? [{ botId: env.TEAMS_BOT_APP_ID, scopes: ['personal', 'team', 'groupchat'] }]
      : []
  }))
}

function allowedHosts(env: TeamsEnv) {
  const configured = (env.TEAMS_WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean)
  return configured.length ? configured : DEFAULT_WEBHOOK_HOSTS
}

function hostMatchesPattern(hostname: string, pattern: string) {
  const host = hostname.toLowerCase()
  const normalizedPattern = pattern.toLowerCase()
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1)
    return host.endsWith(suffix) && host.length > suffix.length
  }
  return host === normalizedPattern
}

async function isAllowedWebhookUrl(url: URL, env: TeamsEnv) {
  if (url.protocol !== 'https:') return false
  if (!allowedHosts(env).some((pattern) => hostMatchesPattern(url.hostname, pattern))) return false
  return hostnameResolvesToPublicAddresses(url.hostname)
}

function normalizeHostname(hostname: string) {
  return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
}

async function hostnameResolvesToPublicAddresses(hostname: string) {
  const host = normalizeHostname(hostname)
  if (isIP(host)) return isPublicIpAddress(host)
  try {
    const addresses = await lookup(host, { all: true, verbatim: true })
    return addresses.length > 0 && addresses.every(({ address }) => isPublicIpAddress(address))
  } catch {
    return false
  }
}

function isPublicIpAddress(address: string) {
  const normalized = normalizeHostname(address)
  const mappedV4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedV4) return isPublicIpv4(mappedV4[1])
  if (isIP(normalized) === 4) return isPublicIpv4(normalized)
  if (isIP(normalized) === 6) return isPublicIpv6(normalized)
  return false
}

function isPublicIpv4(address: string) {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a >= 224) return false
  return true
}

function isPublicIpv6(address: string) {
  const value = address.toLowerCase()
  if (value === '::' || value === '::1') return false
  if (value.startsWith('fc') || value.startsWith('fd')) return false
  if (/^fe[89ab]/.test(value)) return false
  if (value.startsWith('ff')) return false
  return true
}
