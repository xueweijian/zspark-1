export const PROVIDER_RECONNECT_AUTO_INTERRUPT_MS = 60_000
export const TURN_INTERRUPT_FALLBACK_RELEASE_MS = 8_000

export type CompletedTurnWorkKind = 'command' | 'file' | 'tool' | 'web'

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
