import { afterEach, describe, expect, test } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { registerAuthRoutes } from "./auth.js"
import type { AuthenticatedRequest } from "./types.js"

let app: FastifyInstance

afterEach(async () => {
  if (app) {
    await app.close()
  }
})

async function createTestApp(authProps?: Partial<AuthenticatedRequest>) {
  app = Fastify({ logger: false })

  // Mock authentication middleware that sets auth properties
  if (authProps) {
    app.addHook("onRequest", async (req) => {
      const authReq = req as AuthenticatedRequest
      if (authProps.principal !== undefined) authReq.principal = authProps.principal
      if (authProps.oid !== undefined) authReq.oid = authProps.oid
      if (authProps.tid !== undefined) authReq.tid = authProps.tid
      if (authProps.groups !== undefined) authReq.groups = authProps.groups
    })
  }

  await registerAuthRoutes(app)
  await app.ready()
  return app
}

describe("registerAuthRoutes", () => {
  describe("GET /auth/whoami", () => {
    test("returns null values when not authenticated", async () => {
      await createTestApp()

      const response = await app.inject({
        method: "GET",
        url: "/auth/whoami",
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toEqual({
        principal: null,
        oid: null,
        tid: null,
      })
    })

    test("returns authenticated user info when principal is set", async () => {
      await createTestApp({
        principal: "user@example.com",
        oid: "user-object-id-123",
        tid: "tenant-id-456",
      })

      const response = await app.inject({
        method: "GET",
        url: "/auth/whoami",
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toEqual({
        principal: "user@example.com",
        oid: "user-object-id-123",
        tid: "tenant-id-456",
      })
    })

    test("returns partial auth info when only some fields are set", async () => {
      await createTestApp({
        principal: "user@example.com",
      })

      const response = await app.inject({
        method: "GET",
        url: "/auth/whoami",
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toEqual({
        principal: "user@example.com",
        oid: null,
        tid: null,
      })
    })
  })

  describe("POST /auth/handshake", () => {
    test("returns ok:true with null principal when not authenticated", async () => {
      await createTestApp()

      const response = await app.inject({
        method: "POST",
        url: "/auth/handshake",
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toEqual({
        ok: true,
        principal: null,
      })
    })

    test("returns ok:true with principal when authenticated", async () => {
      await createTestApp({
        principal: "admin@example.com",
      })

      const response = await app.inject({
        method: "POST",
        url: "/auth/handshake",
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toEqual({
        ok: true,
        principal: "admin@example.com",
      })
    })

    test("accepts request body without error", async () => {
      await createTestApp({
        principal: "user@example.com",
      })

      const response = await app.inject({
        method: "POST",
        url: "/auth/handshake",
        payload: { clientVersion: "1.0.0" },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().ok).toBe(true)
    })
  })
})
