/**
 * JSON-RPC client over the codex stdio bridge.
 *
 * One module-global pending map keyed by JsonRpcId tracks every in-flight
 * request so an `onExit` notification can reject all of them at once
 * (otherwise the renderer hangs forever waiting on a dead child).
 *
 * Kept side-effect free except for the writes through `window.zspark.send`.
 */
import type { JsonRpcId, Pending } from './appTypes'

let nextId = 1
const newId = () => nextId++

export const pending = new Map<JsonRpcId, Pending>()

export function rejectPendingRequests(message: string): void {
  if (pending.size === 0) return
  const error = new Error(message)
  for (const [, p] of pending) p.reject(error)
  pending.clear()
}

export function send(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = newId()
    pending.set(id, { resolve, reject })
    window.zspark
      .send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      .then((ok) => {
        if (!ok) {
          pending.delete(id)
          reject(new Error('Codex process is not running'))
        }
      })
      .catch((err) => {
        pending.delete(id)
        reject(err)
      })
  })
}

export function sendRpcResult(id: JsonRpcId, result: any) {
  return window.zspark.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

export function sendRpcError(id: JsonRpcId, code: number, message: string) {
  return window.zspark.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
}

export const IGNORED_RPC_ERRORS = new Set(['Not initialized', 'Already initialized'])

export function isMissingRolloutError(message?: string): boolean {
  return /^no rollout found for thread id\b/.test(String(message ?? ''))
}

export function shouldAutoToastRpcError(message?: string): boolean {
  return Boolean(message && !IGNORED_RPC_ERRORS.has(message) && !isMissingRolloutError(message))
}

export function errorMessage(error: any): string {
  return error?.message ? String(error.message) : String(error)
}
