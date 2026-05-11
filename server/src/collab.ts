import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { setupWSConnection } from './yws.js'

const docs = new Map<string, Y.Doc>()

export function getDoc(name: string) {
  let d = docs.get(name)
  if (!d) {
    d = new Y.Doc()
    docs.set(name, d)
  }
  return d
}

export async function registerCollabRoutes(app: FastifyInstance) {
  app.get('/collab/rooms', async () => ({ rooms: [...docs.keys()] }))

  app.get('/collab/:room', { websocket: true }, (socket, req) => {
    const room = (req.params as any).room as string
    const doc = getDoc(room)
    setupWSConnection(socket as any, req.raw, { doc, gc: true })
  })
}
