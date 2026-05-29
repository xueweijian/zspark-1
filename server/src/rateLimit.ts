import type { FastifyInstance, FastifyRequest } from 'fastify'
import Redis from 'ioredis'

interface RateLimitEnv {
  ZSPARK_RATE_LIMIT_WINDOW_MS?: string
  ZSPARK_RATE_LIMIT_MAX?: string
  REDIS_URL?: string
}

interface Bucket {
  windowStart: number
  count: number
}

// In-memory fallback when Redis is unavailable
const memoryBuckets = new Map<string, Bucket>()
let lastCleanupAt = 0

function numberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function requestKey(req: FastifyRequest) {
  const oid = (req as { oid?: string }).oid
  if (oid) return `ratelimit:oid:${oid}`
  const principal = (req as { principal?: string }).principal
  if (principal) return `ratelimit:principal:${String(principal).toLowerCase()}`
  // For anonymous users, use IP only (more secure, harder to bypass)
  return `ratelimit:anon:${req.ip}`
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
  for (const [bucketKey, value] of memoryBuckets) {
    if (now - value.windowStart >= windowMs) memoryBuckets.delete(bucketKey)
  }
}

async function checkRateLimitRedis(
  redis: Redis,
  key: string,
  weight: number,
  windowMs: number,
  max: number
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const now = Date.now()
  const windowKey = `${key}:${Math.floor(now / windowMs)}`
  
  const pipeline = redis.pipeline()
  pipeline.incrby(windowKey, weight)
  pipeline.pttl(windowKey)
  
  const results = await pipeline.exec()
  if (!results) return { allowed: true }
  
  const [incrResult, ttlResult] = results
  const count = (incrResult?.[1] as number) ?? 0
  const ttl = (ttlResult?.[1] as number) ?? -1
  
  // Set expiry on first request in window
  if (ttl === -1) {
    await redis.pexpire(windowKey, windowMs)
  }
  
  if (count > max) {
    const retryAfter = ttl > 0 ? Math.ceil(ttl / 1000) : Math.ceil(windowMs / 1000)
    return { allowed: false, retryAfter }
  }
  
  return { allowed: true }
}

function checkRateLimitMemory(
  key: string,
  weight: number,
  windowMs: number,
  max: number
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  cleanupExpiredBuckets(now, windowMs)
  
  const bucket = memoryBuckets.get(key)
  
  if (!bucket || now - bucket.windowStart >= windowMs) {
    memoryBuckets.set(key, { windowStart: now, count: weight })
    return { allowed: true }
  }
  
  bucket.count += weight
  if (bucket.count > max) {
    const retryAfter = Math.ceil((windowMs - (now - bucket.windowStart)) / 1000)
    return { allowed: false, retryAfter }
  }
  
  if (memoryBuckets.size > 10_000) cleanupExpiredBuckets(now, windowMs, true)
  return { allowed: true }
}

export function registerRateLimit(app: FastifyInstance, env: RateLimitEnv) {
  const windowMs = numberEnv(env.ZSPARK_RATE_LIMIT_WINDOW_MS, 60_000)
  const max = numberEnv(env.ZSPARK_RATE_LIMIT_MAX, 600)
  
  let redis: Redis | null = null
  let redisAvailable = false
  
  if (env.REDIS_URL) {
    try {
      redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 100, 1000)),
        enableOfflineQueue: false,
      })
      
      redis.on('connect', () => {
        redisAvailable = true
        app.log.info('Rate limiting using Redis')
      })
      
      redis.on('error', (err) => {
        if (redisAvailable) {
          app.log.warn({ err }, 'Redis connection lost, falling back to in-memory rate limiting')
        }
        redisAvailable = false
      })
    } catch (err) {
      app.log.warn({ err }, 'Failed to initialize Redis, using in-memory rate limiting')
    }
  }

  app.addHook('onRequest', async (req, reply) => {
    if (requestPath(req.url) === '/healthz') return

    const key = requestKey(req)
    const weight = requestWeight(req)
    
    let result: { allowed: boolean; retryAfter?: number }
    
    if (redis && redisAvailable) {
      try {
        result = await checkRateLimitRedis(redis, key, weight, windowMs, max)
      } catch {
        // Fallback to memory on Redis error
        result = checkRateLimitMemory(key, weight, windowMs, max)
      }
    } else {
      result = checkRateLimitMemory(key, weight, windowMs, max)
    }
    
    if (!result.allowed) {
      reply
        .code(429)
        .header('retry-after', String(result.retryAfter ?? Math.ceil(windowMs / 1000)))
        .send({ error: 'rate limit exceeded' })
      return reply
    }
  })
}
