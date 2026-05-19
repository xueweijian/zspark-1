export const PROVIDER_RECONNECT_AUTO_INTERRUPT_MS = 60_000
export const TURN_INTERRUPT_FALLBACK_RELEASE_MS = 8_000

export type CompletedTurnWorkKind = 'command' | 'file' | 'tool' | 'web'
export type ServerTurnStatus = 'completed' | 'failed' | 'interrupted' | string | undefined
export type LocalTurnStatus = 'completed' | 'failed' | 'interrupted'

export function shouldRecoverFromProviderRetry({
  willRetry,
  completedWorkCount,
  alreadyInterrupting
}: {
  willRetry: boolean
  completedWorkCount: number
  alreadyInterrupting: boolean
}) {
  return willRetry && completedWorkCount > 0 && !alreadyInterrupting
}

export function shouldReleaseCompletedWorkAfterProviderFailure({
  willRetry,
  completedWorkCount,
  alreadyInterrupting,
  isStreamDisconnect
}: {
  willRetry: boolean
  completedWorkCount: number
  alreadyInterrupting: boolean
  isStreamDisconnect: boolean
}) {
  return !willRetry && isStreamDisconnect && completedWorkCount > 0 && !alreadyInterrupting
}

export function turnStatusAfterServerCompletion({
  serverStatus,
  locallyReleased
}: {
  serverStatus: ServerTurnStatus
  locallyReleased: boolean
}): LocalTurnStatus {
  if (locallyReleased && serverStatus === 'failed') return 'interrupted'
  if (serverStatus === 'interrupted') return 'interrupted'
  if (serverStatus === 'failed') return 'failed'
  return 'completed'
}
