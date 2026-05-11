import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { encoding, decoding } from 'lib0'
import type { WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'

const messageSync = 0
const messageAwareness = 1

interface ConnOpts { doc: Y.Doc; gc?: boolean }

export function setupWSConnection(ws: WebSocket, _req: IncomingMessage, { doc }: ConnOpts) {
  const awareness = (doc as any)._zsparkAwareness ?? new awarenessProtocol.Awareness(doc)
  ;(doc as any)._zsparkAwareness = awareness

  ws.binaryType = 'arraybuffer'
  ws.on('message', (data: ArrayBuffer) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data))
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
}
