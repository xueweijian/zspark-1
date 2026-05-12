const FALLBACK_MODEL_METADATA_WARNING = 'Defaulting to fallback metadata'
const DEPRECATED_ON_FAILURE_APPROVAL_WARNING = '`on-failure` approval policy is deprecated'

export function shouldSuppressServerWarning(message: string): boolean {
  return message.includes(FALLBACK_MODEL_METADATA_WARNING) ||
    message.includes(DEPRECATED_ON_FAILURE_APPROVAL_WARNING)
}
