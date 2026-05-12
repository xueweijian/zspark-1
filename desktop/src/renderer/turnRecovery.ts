export const PROVIDER_RECONNECT_AUTO_INTERRUPT_MS = 12_000
export const COMPLETED_WORK_FINALIZATION_TIMEOUT_MS = 35_000
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

export function shouldRecoverFromCompletedWorkStall({
  completedWorkCount,
  alreadyInterrupting
}: {
  completedWorkCount: number
  alreadyInterrupting: boolean
}) {
  return completedWorkCount > 0 && !alreadyInterrupting
}
