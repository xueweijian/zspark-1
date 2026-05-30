import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { registerRateLimit } from "./rateLimit.js"

let app: FastifyInstance

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  if (app) {
    await app.close()
  }
})

async function createTestApp(env: Record<string, string> = {}) {
  app = Fastify({ logger: false })

  // Add a test route
  app.get("/test", async () => ({ ok: true }))
  app.post("/test", async () => ({ ok: true }))
  app.get("/healthz", async () => ({ status: "healthy" }))
  app.post("/artifacts/upload", async () => ({ uploaded: true }))

  registerRateLimit(app, env)
  await app.ready()
  return app
}

describe("registerRateLimit", () => {
  describe("in-memory rate limiting", () => {
    test("allows requests under the limit", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "10",
      })

      const response = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "192.168.1.1" },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: true })
    })

    test("blocks requests over the limit", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "5",
      })

      // Make requests up to the limit (GET = weight 1)
      for (let i = 0; i < 5; i++) {
        const response = await app.inject({
          method: "GET",
          url: "/test",
          headers: { "x-forwarded-for": "192.168.1.100" },
        })
        expect(response.statusCode).toBe(200)
      }

      // Next request should be blocked
      const blockedResponse = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "192.168.1.100" },
      })

      expect(blockedResponse.statusCode).toBe(429)
      expect(blockedResponse.json()).toEqual({ error: "rate limit exceeded" })
      expect(blockedResponse.headers["retry-after"]).toBeDefined()
    })

    test("applies higher weight to POST requests", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "10",
      })

      // POST has weight 3, so 3 POSTs = 9 weight, then 1 more should fail
      for (let i = 0; i < 3; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/test",
          headers: { "x-forwarded-for": "192.168.1.200" },
        })
        expect(response.statusCode).toBe(200)
      }

      // Next POST (weight 3) would exceed limit of 10
      const blockedResponse = await app.inject({
        method: "POST",
        url: "/test",
        headers: { "x-forwarded-for": "192.168.1.200" },
      })

      expect(blockedResponse.statusCode).toBe(429)
    })

    test("applies highest weight to artifact uploads", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "25",
      })

      // Artifact upload has weight 10
      for (let i = 0; i < 2; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/artifacts/upload",
          headers: { "x-forwarded-for": "192.168.1.250" },
        })
        expect(response.statusCode).toBe(200)
      }

      // Third upload (weight 10) would exceed limit of 25
      const blockedResponse = await app.inject({
        method: "POST",
        url: "/artifacts/upload",
        headers: { "x-forwarded-for": "192.168.1.250" },
      })

      expect(blockedResponse.statusCode).toBe(429)
    })

    test("exempts healthz endpoint from rate limiting", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "1",
      })

      // Exhaust the limit
      await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "192.168.1.50" },
      })

      // Healthz should still work
      const healthResponse = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-forwarded-for": "192.168.1.50" },
      })

      expect(healthResponse.statusCode).toBe(200)
      expect(healthResponse.json()).toEqual({ status: "healthy" })
    })

    test("uses different buckets for different IPs", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "2",
      })

      // Exhaust limit for IP 1
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: "GET",
          url: "/test",
          headers: { "x-forwarded-for": "10.0.0.1" },
        })
      }

      // IP 1 should be blocked
      const blocked = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "10.0.0.1" },
      })
      expect(blocked.statusCode).toBe(429)

      // IP 2 should still work
      const allowed = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "10.0.0.2" },
      })
      expect(allowed.statusCode).toBe(200)
    })

    test("resets rate limit after window expires", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "1000",
        ZSPARK_RATE_LIMIT_MAX: "1",
      })

      // Use up the limit
      await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "172.16.0.1" },
      })

      // Should be blocked
      const blocked = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "172.16.0.1" },
      })
      expect(blocked.statusCode).toBe(429)

      // Advance time past the window
      vi.advanceTimersByTime(1500)

      // Should be allowed again
      const allowed = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "172.16.0.1" },
      })
      expect(allowed.statusCode).toBe(200)
    })

    test("uses default values when env vars are invalid", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "invalid",
        ZSPARK_RATE_LIMIT_MAX: "-5",
      })

      // Should use defaults (600 max, 60000ms window)
      // Make many requests - should not be blocked with default high limit
      for (let i = 0; i < 50; i++) {
        const response = await app.inject({
          method: "GET",
          url: "/test",
          headers: { "x-forwarded-for": "192.168.100.1" },
        })
        expect(response.statusCode).toBe(200)
      }
    })
  })

  describe("authenticated user rate limiting", () => {
    test("uses principal for rate limit key when authenticated", async () => {
      app = Fastify({ logger: false })

      // Mock auth middleware
      app.addHook("onRequest", async (req) => {
        ;(req as any).principal = "user@example.com"
      })

      app.get("/test", async () => ({ ok: true }))
      registerRateLimit(app, {
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "2",
      })
      await app.ready()

      // Same principal from different IPs should share limit
      await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "1.1.1.1" },
      })
      await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "2.2.2.2" },
      })

      // Third request should be blocked regardless of IP
      const blocked = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "3.3.3.3" },
      })
      expect(blocked.statusCode).toBe(429)
    })

    test("uses oid for rate limit key when available", async () => {
      app = Fastify({ logger: false })

      app.addHook("onRequest", async (req) => {
        ;(req as any).oid = "user-object-id-abc"
      })

      app.get("/test", async () => ({ ok: true }))
      registerRateLimit(app, {
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "1",
      })
      await app.ready()

      await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "5.5.5.5" },
      })

      const blocked = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": "6.6.6.6" },
      })
      expect(blocked.statusCode).toBe(429)
    })
  })
})
