import { describe, expect, test } from 'vitest'
import {
  buildMcpServersTomlValue,
  generateMcpServerId,
  sanitizeMcpServer,
  sanitizeMcpServerList
} from './mcpServers'

describe('sanitizeMcpServer', () => {
  test('returns null for malformed input', () => {
    expect(sanitizeMcpServer(null)).toBeNull()
    expect(sanitizeMcpServer({})).toBeNull()
    expect(sanitizeMcpServer({ id: '', name: 'x', command: 'c' })).toBeNull()
    expect(sanitizeMcpServer({ id: 'a', name: '', command: 'c' })).toBeNull()
    expect(sanitizeMcpServer({ id: 'a', name: 'n', command: '' })).toBeNull()
  })

  test('coerces args and env to safe shapes', () => {
    const entry = sanitizeMcpServer({
      id: 'gmail',
      name: 'gmail',
      command: 'node',
      args: ['server.js', 42, 'ok'],
      env: { GMAIL_CLIENT_ID: 'cid', BROKEN: 9 },
      enabled: undefined
    })
    expect(entry).toEqual({
      id: 'gmail',
      name: 'gmail',
      command: 'node',
      args: ['server.js', 'ok'],
      env: { GMAIL_CLIENT_ID: 'cid' },
      enabled: true
    })
  })

  test('respects explicit enabled=false', () => {
    expect(sanitizeMcpServer({ id: 'a', name: 'a', command: 'c', enabled: false })?.enabled).toBe(false)
  })
})

describe('sanitizeMcpServerList', () => {
  test('drops bad records and dedupes by id', () => {
    const out = sanitizeMcpServerList([
      { id: 'a', name: 'a', command: 'c' },
      null,
      { id: 'a', name: 'dup', command: 'd' },
      { id: 'b', name: 'b', command: 'c' }
    ])
    expect(out.map((s) => s.id)).toEqual(['a', 'b'])
  })

  test('returns empty array for non-array input', () => {
    expect(sanitizeMcpServerList(undefined)).toEqual([])
    expect(sanitizeMcpServerList('nope')).toEqual([])
  })
})

describe('buildMcpServersTomlValue', () => {
  test('returns empty inline table when nothing enabled', () => {
    expect(buildMcpServersTomlValue([])).toBe('{}')
    expect(
      buildMcpServersTomlValue([
        { id: 'a', name: 'a', command: 'c', args: [], env: {}, enabled: false }
      ])
    ).toBe('{}')
  })

  test('encodes command/args/env with TOML-safe escaping', () => {
    const toml = buildMcpServersTomlValue([
      {
        id: 'gmail',
        name: 'gmail',
        command: 'node',
        args: ['C:\\bin\\server.js', 'flag="x"'],
        env: { GMAIL_CLIENT_ID: 'cid', SECRET: 'a"b' },
        enabled: true
      }
    ])
    expect(toml).toContain('gmail = {')
    expect(toml).toContain('command = "node"')
    expect(toml).toContain('"C:\\\\bin\\\\server.js"')
    expect(toml).toContain('"flag=\\"x\\""')
    expect(toml).toContain('GMAIL_CLIENT_ID = "cid"')
    expect(toml).toContain('SECRET = "a\\"b"')
  })

  test('quotes server names that are not bare TOML keys', () => {
    const toml = buildMcpServersTomlValue([
      { id: 'x', name: 'gmail.demo', command: 'node', args: [], env: {}, enabled: true }
    ])
    expect(toml).toContain('"gmail.demo" = {')
  })

  test('skips disabled entries but keeps enabled siblings', () => {
    const toml = buildMcpServersTomlValue([
      { id: '1', name: 'a', command: 'c', args: [], env: {}, enabled: false },
      { id: '2', name: 'b', command: 'd', args: [], env: {}, enabled: true }
    ])
    expect(toml).not.toContain('a = {')
    expect(toml).toContain('b = {')
  })
})

describe('generateMcpServerId', () => {
  test('produces unique-looking ids', () => {
    const a = generateMcpServerId()
    const b = generateMcpServerId()
    expect(a).not.toBe(b)
    expect(a.startsWith('mcp-')).toBe(true)
  })
})
