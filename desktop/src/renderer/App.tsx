import React, { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    zspark: {
      send: (line: string) => Promise<boolean>
      restart: () => Promise<boolean>
      onStdout: (cb: (s: string) => void) => void
      onStderr: (cb: (s: string) => void) => void
      onExit: (cb: (code: number | null) => void) => void
    }
  }
}

const sidebarItems = ['New chat', 'Search', 'Skills', 'Plugins', 'Automations']
let nextId = 1
const newId = () => nextId++

interface Pending {
  resolve: (msg: any) => void
  reject: (err: any) => void
}
const pending = new Map<number, Pending>()

function send(method: string, params: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const id = newId()
    pending.set(id, { resolve, reject })
    window.zspark.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

function notify(method: string, params: any = {}) {
  window.zspark.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
}

export function App() {
  const [log, setLog] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [thread, setThread] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const buf = useRef('')
  const streamRef = useRef<HTMLDivElement>(null)

  const append = (s: string) => setLog((p) => [...p, s])

  useEffect(() => {
    window.zspark.onStdout((chunk) => {
      buf.current += chunk
      let nl: number
      while ((nl = buf.current.indexOf('\n')) !== -1) {
        const line = buf.current.slice(0, nl).trim()
        buf.current = buf.current.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (typeof msg.id === 'number' && pending.has(msg.id)) {
            pending.get(msg.id)!.resolve(msg)
            pending.delete(msg.id)
            if (msg.error) append(`✗ rpc#${msg.id} ${msg.error.code}: ${msg.error.message}`)
          } else if (msg.method) {
            // notification / event from server
            if (msg.method.startsWith('thread/') || msg.method.startsWith('turn/')) {
              const t = msg.params?.delta?.text ?? msg.params?.text ?? msg.params?.message?.content ?? ''
              if (t) append(t)
              else append(`[${msg.method}]`)
            } else {
              append(`[${msg.method}] ${JSON.stringify(msg.params).slice(0, 200)}`)
            }
          }
        } catch {
          append(line)
        }
      }
    })
    window.zspark.onStderr((s) => append(`[stderr] ${s.trim()}`))
    window.zspark.onExit((c) => append(`\n[codex exited: ${c}]`))

    ;(async () => {
      try {
        const init = await send('initialize', {
          clientInfo: { name: 'zspark-desktop', version: '0.0.1' }
        })
        append(`✓ initialize: ${init.error ? init.error.message : 'ok'}`)
        const t = await send('thread/start', {})
        const tid = t.result?.thread?.id ?? null
        setThread(tid)
        append(`✓ thread started: ${tid}`)
        setReady(true)
      } catch (e: any) {
        append(`✗ handshake failed: ${e?.message ?? e}`)
      }
    })()
  }, [])

  useEffect(() => {
    streamRef.current?.scrollTo(0, streamRef.current.scrollHeight)
  }, [log])

  const submit = async () => {
    if (!input.trim() || !ready) return
    const text = input
    append(`> ${text}`)
    setInput('')
    try {
      await send('turn/start', {
        threadId: thread,
        input: [{ type: 'text', text, textElements: [] }]
      })
    } catch (e: any) {
      append(`✗ turn failed: ${e?.message ?? e}`)
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        {sidebarItems.map((it) => (
          <div className="item" key={it}>{it}</div>
        ))}
        <h3>Projects</h3>
        <div className="item">zspark</div>
      </aside>
      <main className="chat">
        <div className="chat-header">What should we build?</div>
        <div className="chat-stream" ref={streamRef}>
          {log.length === 0 ? 'Connecting to codex app-server...' : log.join('\n')}
        </div>
        <div className="chat-input">
          <input
            placeholder={ready ? 'Ask zspark anything...' : 'Connecting...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            disabled={!ready}
          />
          <button onClick={submit} disabled={!ready}>Send</button>
        </div>
      </main>
      <aside className="right">
        <h4>Workspace</h4>
        <div>Thread: {thread ?? '—'}</div>
        <div>Sandbox: AppContainer (Win) / Seatbelt (mac)</div>
        <div>Auth: Entra ID (Azure China)</div>
        <div>Collab: zspark-server @ 143.64.174.225:8787</div>
      </aside>
    </div>
  )
}
