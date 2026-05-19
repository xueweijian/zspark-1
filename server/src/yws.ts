import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { encoding, decoding } from 'lib0'
import type { WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'

const messageSync = 0
const messageAwareness = 1
const wsOpen = 1

interface ConnOpts { doc: Y.Doc; gc?: boolean; onEmpty?: () => void }

type ConnMap = Map<WebSocket, Set<number>>
interface DocConnectionState {
  awareness: awarenessProtocol.Awareness
  conns: ConnMap
  updateHandlerInstalled: boolean
  awarenessHandlerInstalled: boolean
}

const docConnectionStates = new WeakMap<Y.Doc, DocConnectionState>()

function connectionStateForDoc(doc: Y.Doc): DocConnectionState {
  let state = docConnectionStates.get(doc)
  if (!state) {
    state = {
      awareness: new awarenessProtocol.Awareness(doc),
      conns: new Map(),
      updateHandlerInstalled: false,
      awarenessHandlerInstalled: false
    }
    docConnectionStates.set(doc, state)
  }
  return state
}

export function destroyDocConnectionState(doc: Y.Doc) {
  const state = docConnectionStates.get(doc)
  state?.awareness.destroy()
  docConnectionStates.delete(doc)
}

export function setupWSConnection(ws: WebSocket, _req: IncomingMessage, { doc, onEmpty }: ConnOpts) {
  const state = connectionStateForDoc(doc)
  const { awareness, conns } = state

  if (!state.updateHandlerInstalled) {
    const updateHandler = (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      broadcast(conns, encoding.toUint8Array(encoder), origin)
    }
    state.updateHandlerInstalled = true
    doc.on('update', updateHandler)
  }

  if (!state.awarenessHandlerInstalled) {
    const awarenessHandler = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const controlledIds = conns.get(origin as WebSocket)
      if (controlledIds) {
        for (const id of added.concat(updated)) controlledIds.add(id)
        for (const id of removed) controlledIds.delete(id)
      }
      const changed = added.concat(updated, removed)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
      broadcast(conns, encoding.toUint8Array(encoder), origin)
    }
    state.awarenessHandlerInstalled = true
    awareness.on('update', awarenessHandler)
  }

  ws.binaryType = 'arraybuffer'
  conns.set(ws, new Set())

  ws.on('message', (data) => {
    try {
      const decoder = decoding.createDecoder(rawDataToUint8Array(data))
      const encoder = encoding.createEncoder()
      const messageType = decoding.readVarUint(decoder)
      switch (messageType) {
        case messageSync:
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.readSyncMessage(decoder, encoder, doc, ws)
          if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder))
          break
        case messageAwareness:
          awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), ws)
          break
      }
    } catch (e) {
      console.error('ws message error', e)
    }
  })

  // initial sync
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  ws.send(encoding.toUint8Array(encoder))

  const states = awareness.getStates()
  if (states.size) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, messageAwareness)
    encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys())))
    ws.send(encoding.toUint8Array(awarenessEncoder))
  }

  ws.on('close', () => {
    const controlledIds = conns.get(ws)
    conns.delete(ws)
    if (controlledIds?.size) awarenessProtocol.removeAwarenessStates(awareness, Array.from(controlledIds), ws)
    if (conns.size === 0) onEmpty?.()
  })
}

function broadcast(conns: ConnMap, message: Uint8Array, origin: unknown) {
  for (const conn of conns.keys()) {
    if (conn === origin || conn.readyState !== wsOpen) continue
    conn.send(message)
  }
}

function rawDataToUint8Array(data: any) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(Buffer.from(data))
}
