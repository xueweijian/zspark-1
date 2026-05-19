import type { FastifyInstance, FastifyRequest } from 'fastify'

interface RateLimitEnv {
  ZSPARK_RATE_LIMIT_WINDOW_MS?: string
  ZSPARK_RATE_LIMIT_MAX?: string
}

interface Bucket {
  windowStart: number
  count: number
}

const buckets = new Map<string, Bucket>()
let lastCleanupAt = 0

function numberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function requestKey(req: FastifyRequest) {
  const oid = (req as any).oid
  if (oid) return `oid:${oid}`
  const principal = (req as any).principal
  if (principal) return `principal:${String(principal).toLowerCase()}`
  const userAgent = String(req.headers['user-agent'] ?? 'unknown').slice(0, 120)
  return `anonymous:${req.ip}:${requestPath(req.url)}:${userAgent}`
}

function requestWeight(req: FastifyRequest) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return 1
  if (req.url.includes('/artifacts')) return 10
  return 3
}

function requestPath(url: string) {
  try {
    return new URL(url, 'http://zspark.local').pathname
  } catch {
    return url.split('?')[0] ?? url
  }
}

function cleanupExpiredBuckets(now: number, windowMs: number, force = false) {
  if (!force && now - lastCleanupAt < windowMs) return
  lastCleanupAt = now
  for (const [bucketKey, value] of buckets) {
    if (now - value.windowStart >= windowMs) buckets.delete(bucketKey)
  }
}

export function registerRateLimit(app: FastifyInstance, env: RateLimitEnv) {
  const windowMs = numberEnv(env.ZSPARK_RATE_LIMIT_WINDOW_MS, 60_000)
  const max = numberEnv(env.ZSPARK_RATE_LIMIT_MAX, 600)

  app.addHook('onRequest', async (req, reply) => {
    if (requestPath(req.url) === '/healthz') return

    const now = Date.now()
    cleanupExpiredBuckets(now, windowMs)
    const key = requestKey(req)
    const weight = requestWeight(req)
    const bucket = buckets.get(key)

    if (!bucket || now - bucket.windowStart >= windowMs) {
      buckets.set(key, { windowStart: now, count: weight })
      return
    }

    bucket.count += weight
    if (bucket.count > max) {
      reply
        .code(429)
        .header('retry-after', String(Math.ceil((windowMs - (now - bucket.windowStart)) / 1000)))
        .send({ error: 'rate limit exceeded' })
      return reply
    }

    if (buckets.size > 10_000) cleanupExpiredBuckets(now, windowMs, true)
  })
}
