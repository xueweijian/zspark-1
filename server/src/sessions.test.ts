import { describe, expect, test, vi, beforeEach } from "vitest"
import { z } from "zod"

// Test the Zod schemas used for input validation in sessions.ts
// These schemas are critical for security - they prevent oversized payloads and injection

describe("Session Input Validation Schemas", () => {
  // Recreate schemas from sessions.ts for testing
  const JsonRpcIdSchema = z.union([z.string().max(200), z.number()])
  const ActivityKindSchema = z.enum(["reasoning", "command", "file", "tool", "web", "memory"])
  const ActivityActionKindSchema = z.enum(["read", "write", "list", "search", "run", "build", "verify", "tool", "file"])

  const ActivitySchema = z
    .object({
      id: z.string().max(240),
      kind: ActivityKindSchema,
      title: z.string().max(500),
      detail: z.string().max(6000).optional(),
      actionKind: ActivityActionKindSchema.optional(),
      target: z.string().max(1200).optional(),
      status: z.enum(["running", "done", "failed"]),
      startedAt: z.number(),
      endedAt: z.number().optional(),
    })
    .strict()

  const ApprovalParamsSchema = z.unknown().transform((value) => {
    if (value === undefined) return undefined
    try {
      const json = JSON.stringify(value)
      if (json.length <= 32_000) return value
      return { truncated: true, preview: json.slice(0, 32_000) }
    } catch {
      return undefined
    }
  })

  const WorkspaceFileSchema = z
    .object({
      id: z.string().max(240),
      name: z.string().max(240),
      path: z.string().max(1400),
      source: z.enum(["attachment", "change"]),
      status: z.enum(["attached", "created", "modified", "deleted", "missing"]),
      detail: z.string().max(1000).optional(),
      updatedAt: z.number(),
      sharedArtifact: z
        .object({
          workspaceId: z.string().max(160),
          sessionId: z.string().max(160),
          artifactId: z.string().max(160),
          sizeBytes: z.number().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()

  describe("JsonRpcIdSchema", () => {
    test("accepts valid string IDs", () => {
      expect(JsonRpcIdSchema.parse("request-123")).toBe("request-123")
    })

    test("accepts valid number IDs", () => {
      expect(JsonRpcIdSchema.parse(42)).toBe(42)
    })

    test("rejects strings over 200 characters", () => {
      const longId = "a".repeat(201)
      expect(() => JsonRpcIdSchema.parse(longId)).toThrow()
    })

    test("accepts strings at exactly 200 characters", () => {
      const maxId = "a".repeat(200)
      expect(JsonRpcIdSchema.parse(maxId)).toBe(maxId)
    })
  })

  describe("ActivityKindSchema", () => {
    test("accepts all valid activity kinds", () => {
      const validKinds = ["reasoning", "command", "file", "tool", "web", "memory"]
      for (const kind of validKinds) {
        expect(ActivityKindSchema.parse(kind)).toBe(kind)
      }
    })

    test("rejects invalid activity kinds", () => {
      expect(() => ActivityKindSchema.parse("invalid")).toThrow()
      expect(() => ActivityKindSchema.parse("")).toThrow()
      expect(() => ActivityKindSchema.parse(123)).toThrow()
    })
  })

  describe("ActivitySchema", () => {
    const validActivity = {
      id: "activity-1",
      kind: "command" as const,
      title: "Running tests",
      status: "running" as const,
      startedAt: Date.now(),
    }

    test("accepts valid activity", () => {
      const result = ActivitySchema.parse(validActivity)
      expect(result.id).toBe("activity-1")
      expect(result.kind).toBe("command")
    })

    test("accepts activity with optional fields", () => {
      const activity = {
        ...validActivity,
        detail: "Running unit tests",
        actionKind: "run" as const,
        target: "/src/tests",
        endedAt: Date.now() + 1000,
      }
      const result = ActivitySchema.parse(activity)
      expect(result.detail).toBe("Running unit tests")
    })

    test("rejects activity with title over 500 characters", () => {
      const activity = {
        ...validActivity,
        title: "x".repeat(501),
      }
      expect(() => ActivitySchema.parse(activity)).toThrow()
    })

    test("rejects activity with detail over 6000 characters", () => {
      const activity = {
        ...validActivity,
        detail: "x".repeat(6001),
      }
      expect(() => ActivitySchema.parse(activity)).toThrow()
    })

    test("rejects activity with extra properties (strict mode)", () => {
      const activity = {
        ...validActivity,
        extraField: "should not be allowed",
      }
      expect(() => ActivitySchema.parse(activity)).toThrow()
    })

    test("rejects activity missing required fields", () => {
      const { id, ...missingId } = validActivity
      expect(() => ActivitySchema.parse(missingId)).toThrow()
    })
  })

  describe("ApprovalParamsSchema", () => {
    test("passes through small objects unchanged", () => {
      const params = { command: "npm test", args: ["--coverage"] }
      const result = ApprovalParamsSchema.parse(params)
      expect(result).toEqual(params)
    })

    test("truncates objects over 32KB", () => {
      const largeParams = { data: "x".repeat(40_000) }
      const result = ApprovalParamsSchema.parse(largeParams) as { truncated: boolean; preview: string }
      expect(result.truncated).toBe(true)
      expect(result.preview.length).toBe(32_000)
    })

    test("returns undefined for undefined input", () => {
      const result = ApprovalParamsSchema.parse(undefined)
      expect(result).toBeUndefined()
    })

    test("handles circular references gracefully", () => {
      const circular: any = { a: 1 }
      circular.self = circular
      const result = ApprovalParamsSchema.parse(circular)
      expect(result).toBeUndefined()
    })
  })

  describe("WorkspaceFileSchema", () => {
    const validFile = {
      id: "file-1",
      name: "test.ts",
      path: "/src/test.ts",
      source: "change" as const,
      status: "modified" as const,
      updatedAt: Date.now(),
    }

    test("accepts valid workspace file", () => {
      const result = WorkspaceFileSchema.parse(validFile)
      expect(result.name).toBe("test.ts")
    })

    test("accepts file with shared artifact", () => {
      const file = {
        ...validFile,
        sharedArtifact: {
          workspaceId: "ws-1",
          sessionId: "sess-1",
          artifactId: "art-1",
          sizeBytes: 1024,
        },
      }
      const result = WorkspaceFileSchema.parse(file)
      expect(result.sharedArtifact?.artifactId).toBe("art-1")
    })

    test("rejects file with path over 1400 characters", () => {
      const file = {
        ...validFile,
        path: "/".repeat(1401),
      }
      expect(() => WorkspaceFileSchema.parse(file)).toThrow()
    })

    test("rejects invalid source type", () => {
      const file = {
        ...validFile,
        source: "invalid",
      }
      expect(() => WorkspaceFileSchema.parse(file)).toThrow()
    })

    test("rejects invalid status", () => {
      const file = {
        ...validFile,
        status: "unknown",
      }
      expect(() => WorkspaceFileSchema.parse(file)).toThrow()
    })
  })
})

describe("Session Security Boundaries", () => {
  test("title is capped at 160 characters", () => {
    const CreateSessionBody = z.object({
      title: z.string().max(160).optional(),
      localThreadId: z.string().max(160).optional(),
    })

    const longTitle = "x".repeat(161)
    expect(() => CreateSessionBody.parse({ title: longTitle })).toThrow()

    const validTitle = "x".repeat(160)
    expect(CreateSessionBody.parse({ title: validTitle }).title).toBe(validTitle)
  })

  test("blocks array is capped at 800 items", () => {
    const BlocksSchema = z.array(z.unknown()).max(800)

    const tooManyBlocks = new Array(801).fill({ type: "user", id: "1", text: "hi" })
    expect(() => BlocksSchema.parse(tooManyBlocks)).toThrow()

    const validBlocks = new Array(800).fill({ type: "user", id: "1", text: "hi" })
    expect(BlocksSchema.parse(validBlocks).length).toBe(800)
  })

  test("artifacts array is capped at 200 items", () => {
    const ArtifactsSchema = z.array(z.unknown()).max(200)

    const tooManyArtifacts = new Array(201).fill({})
    expect(() => ArtifactsSchema.parse(tooManyArtifacts)).toThrow()
  })

  test("approval paths array is capped at 200 items", () => {
    const PathsSchema = z.array(z.string().max(1200)).max(200)

    const tooManyPaths = new Array(201).fill("/some/path")
    expect(() => PathsSchema.parse(tooManyPaths)).toThrow()
  })

  test("text content is capped at 200KB for user blocks", () => {
    const UserBlockSchema = z.object({
      type: z.literal("user"),
      id: z.string().max(240),
      text: z.string().max(200_000),
    })

    const tooLongText = "x".repeat(200_001)
    expect(() => UserBlockSchema.parse({ type: "user", id: "1", text: tooLongText })).toThrow()
  })

  test("text content is capped at 1MB for agent blocks", () => {
    const AgentBlockSchema = z.object({
      type: z.literal("agent"),
      id: z.string().max(240),
      text: z.string().max(1_000_000),
    })

    const validLongText = "x".repeat(1_000_000)
    expect(AgentBlockSchema.parse({ type: "agent", id: "1", text: validLongText }).text.length).toBe(1_000_000)

    const tooLongText = "x".repeat(1_000_001)
    expect(() => AgentBlockSchema.parse({ type: "agent", id: "1", text: tooLongText })).toThrow()
  })
})
