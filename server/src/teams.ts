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
const deliveredActivityIds = new Set<string>()

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
    if (!isAllowedWebhookUrl(url, env)) {
      return reply.code(403).send({ error: 'webhook host is not allowed' })
    }
    if (activityId && deliveredActivityIds.has(activityId)) {
      return { delivered: true, duplicate: true }
    }
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000)
    })
    if (activityId && r.ok) {
      deliveredActivityIds.add(activityId)
      if (deliveredActivityIds.size > 10_000) deliveredActivityIds.clear()
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

function isAllowedWebhookUrl(url: URL, env: TeamsEnv) {
  if (url.protocol !== 'https:') return false
  return allowedHosts(env).some((pattern) => hostMatchesPattern(url.hostname, pattern))
}
