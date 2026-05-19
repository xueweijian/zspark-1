import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { destroyDocConnectionState, setupWSConnection } from './yws.js'
import { canAccessWorkspace } from './workspaces.js'

interface RoomEntry {
  doc: Y.Doc
  destroyed: boolean
}

const docs = new Map<string, RoomEntry>()

export function getDoc(name: string) {
  let entry = docs.get(name)
  if (!entry || entry.destroyed) {
    const doc = new Y.Doc()
    entry = { doc, destroyed: false }
    docs.set(name, entry)
  }
  return entry.doc
}

export async function registerCollabRoutes(app: FastifyInstance) {
  app.get('/collab/rooms', async (req) => {
    const rooms: string[] = []
    for (const room of docs.keys()) {
      const workspaceId = room.startsWith('workspace:') ? room.slice('workspace:'.length) : null
      if (workspaceId && (await canAccessWorkspace(req, workspaceId))) rooms.push(room)
    }
    return { rooms }
  })

  app.get('/collab/:room', { websocket: true }, async (socket, req) => {
    const room = (req.params as any).room as string
    const workspaceId = room.startsWith('workspace:') ? room.slice('workspace:'.length) : null
    if (!workspaceId || !(await canAccessWorkspace(req, workspaceId))) {
      socket.close(1008, 'workspace access denied')
      return
    }
    const doc = getDoc(room)
    setupWSConnection(socket as any, req.raw, {
      doc,
      gc: true,
      onEmpty: () => {
        const entry = docs.get(room)
        // Reconnects between scheduling and execution can already have
        // attached new clients to the same doc — only tear it down if the
        // entry we hold is still the live one and nothing new joined.
        if (!entry || entry.doc !== doc || entry.destroyed) return
        entry.destroyed = true
        docs.delete(room)
        destroyDocConnectionState(doc)
        doc.destroy()
      }
    })
  })
}
