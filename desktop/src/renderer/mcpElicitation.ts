export interface McpElicitationResponse {
  action: 'accept' | 'decline'
  content: Record<string, unknown> | null
  reason?: 'structured-input' | 'url' | 'malformed'
}

function hasEmptyRequestedSchema(params: any): boolean {
  const properties = params?.requestedSchema?.properties
  return Boolean(properties && typeof properties === 'object' && !Array.isArray(properties) && Object.keys(properties).length === 0)
}

export function responseForMcpElicitationRequest(params: any): McpElicitationResponse {
  if (params?.mode === 'form' && hasEmptyRequestedSchema(params)) {
    return { action: 'accept', content: {} }
  }
  if (params?.mode === 'form') return { action: 'decline', content: null, reason: 'structured-input' }
  if (params?.mode === 'url') return { action: 'decline', content: null, reason: 'url' }
  return { action: 'decline', content: null, reason: 'malformed' }
}
