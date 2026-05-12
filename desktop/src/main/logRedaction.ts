const SENSITIVE_KEY_RE = /(authorization|api[_-]?key|token|secret|password|bearer)/i
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+@)/gi
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|token|access[_-]?token|secret|password)=)[^&\s]+/gi
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g

export function redactSensitiveString(value: string): string {
  return value
    .replace(URL_USERINFO_RE, '$1[redacted]@')
    .replace(BEARER_RE, '$1[redacted]')
    .replace(QUERY_SECRET_RE, '$1[redacted]')
    .replace(GITHUB_TOKEN_RE, '[redacted]')
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveString(value)
  if (Array.isArray(value)) return value.map(redactSensitiveValue)
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redactSensitiveValue(child)
  }
  return out
}

export function redactSensitiveLogLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return line
  try {
    return JSON.stringify(redactSensitiveValue(JSON.parse(trimmed)))
  } catch {
    return redactSensitiveString(line)
  }
}
