import { afterEach, describe, expect, test } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { registerRateLimit } from "./rateLimit.js"

let app: FastifyInstance

// Use timestamp + random to ensure unique IPs across test runs
function uniqueIp() {
  const ts = Date.now()
  const rand = Math.floor(Math.random() * 1000000)
  return "unique-ip-" + ts + "-" + rand
}

afterEach(async () => {
  if (app) {
    await app.close()
  }
})

async function createTestApp(env: Record<string, string> = {}) {
  app = Fastify({ 
    logger: false,
    trustProxy: true  // Enable trust proxy to use x-forwarded-for
  })

  app.get("/test", async () => ({ ok: true }))
  app.post("/test", async () => ({ ok: true }))
  app.get("/healthz", async () => ({ status: "healthy" }))
  app.post("/artifacts/upload", async () => ({ uploaded: true }))

  registerRateLimit(app, env)
  await app.ready()
  return app
}

describe("registerRateLimit", () => {
  describe("basic functionality", () => {
    test("allows requests under the limit", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "100",
      })

      const response = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": uniqueIp() },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: true })
    })

    test("exempts healthz endpoint from rate limiting", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "100",
      })

      const healthResponse = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-forwarded-for": uniqueIp() },
      })

      expect(healthResponse.statusCode).toBe(200)
      expect(healthResponse.json()).toEqual({ status: "healthy" })
    })

    test("uses default values when env vars are invalid", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "invalid",
        ZSPARK_RATE_LIMIT_MAX: "-5",
      })

      const response = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": uniqueIp() },
      })
      expect(response.statusCode).toBe(200)
    })

    test("returns 429 with retry-after header when limit exceeded", async () => {
      await createTestApp({
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "1",
      })

      const ip = uniqueIp()

      const first = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": ip },
      })
      expect(first.statusCode).toBe(200)

      const blocked = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": ip },
      })

      expect(blocked.statusCode).toBe(429)
      expect(blocked.json()).toEqual({ error: "rate limit exceeded" })
      expect(blocked.headers["retry-after"]).toBeDefined()
    })
  })

  describe("rate limit key selection", () => {
    test("uses oid when available", async () => {
      app = Fastify({ logger: false, trustProxy: true })

      const testOid = uniqueIp()
      app.addHook("onRequest", async (req) => {
        ;(req as any).oid = testOid
      })

      app.get("/test", async () => ({ ok: true }))
      registerRateLimit(app, {
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "1",
      })
      await app.ready()

      const first = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": uniqueIp() },
      })
      expect(first.statusCode).toBe(200)

      const blocked = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": uniqueIp() },
      })
      expect(blocked.statusCode).toBe(429)
    })

    test("uses principal when oid not available", async () => {
      app = Fastify({ logger: false, trustProxy: true })

      const testPrincipal = uniqueIp() + "@example.com"
      app.addHook("onRequest", async (req) => {
        ;(req as any).principal = testPrincipal
      })

      app.get("/test", async () => ({ ok: true }))
      registerRateLimit(app, {
        ZSPARK_RATE_LIMIT_WINDOW_MS: "60000",
        ZSPARK_RATE_LIMIT_MAX: "1",
      })
      await app.ready()

      const first = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": uniqueIp() },
      })
      expect(first.statusCode).toBe(200)

      const blocked = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-forwarded-for": uniqueIp() },
      })
      expect(blocked.statusCode).toBe(429)
    })
  })
})
