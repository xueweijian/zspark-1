const SENSITIVE_KEY_RE = /(authorization|api[_-]?key|client[_-]?id|token|secret|password|bearer)/i
const SECRET_KEY_SOURCE = String.raw`[\w.-]*(?:authorization|api[_-]?key|client[_-]?id|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|credential|bearer)[\w.-]*`
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+@)/gi
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|client[_-]?id|token|access[_-]?token|secret|password)=)[^&\s]+/gi
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g
const DOUBLE_QUOTED_SECRET_ASSIGNMENT_RE = new RegExp(String.raw`((?:"?${SECRET_KEY_SOURCE}"?\s*[:=]\s*)")(?:(?:\\.)|[^"\\])*"`, 'gi')
const SINGLE_QUOTED_SECRET_ASSIGNMENT_RE = new RegExp(String.raw`((?:'?${SECRET_KEY_SOURCE}'?\s*[:=]\s*)')(?:(?:\\.)|[^'\\])*'`, 'gi')
const ESCAPED_DOUBLE_QUOTED_SECRET_ASSIGNMENT_RE = new RegExp(String.raw`(\b${SECRET_KEY_SOURCE}\b\s*[:=]\s*\\").*?(\\")`, 'gi')
const ESCAPED_JSON_SECRET_ASSIGNMENT_RE = new RegExp(String.raw`(\\"${SECRET_KEY_SOURCE}\\"\s*:\s*\\").*?(\\")`, 'gi')
const UNQUOTED_SECRET_ASSIGNMENT_RE = new RegExp(String.raw`(\b${SECRET_KEY_SOURCE}\b\s*[:=]\s*)(?!\\?["']|\[redacted\])[^,\s}\]]+`, 'gi')

export function redactSensitiveString(value: string): string {
  return value
    .replace(URL_USERINFO_RE, '$1[redacted]@')
    .replace(ESCAPED_JSON_SECRET_ASSIGNMENT_RE, '$1[redacted]$2')
    .replace(ESCAPED_DOUBLE_QUOTED_SECRET_ASSIGNMENT_RE, '$1[redacted]$2')
    .replace(DOUBLE_QUOTED_SECRET_ASSIGNMENT_RE, '$1[redacted]"')
    .replace(SINGLE_QUOTED_SECRET_ASSIGNMENT_RE, "$1[redacted]'")
    .replace(UNQUOTED_SECRET_ASSIGNMENT_RE, '$1[redacted]')
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

export function redactSensitiveLogText(text: string): string {
  return text.split(/(\r?\n)/).map((part) => (
    part === '\n' || part === '\r\n' ? part : redactSensitiveLogLine(part)
  )).join('')
}

export function redactProcessArgsForLog(args: string[]): string[] {
  return args.map((arg) => (
    arg.startsWith('mcp_servers=') ? 'mcp_servers=[redacted]' : redactSensitiveString(arg)
  ))
}
