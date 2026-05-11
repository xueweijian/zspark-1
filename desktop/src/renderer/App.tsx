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
  const messages = useRef<Map<string, number>>(new Map()) // itemId -> log index
  const buf = useRef('')
  const streamRef = useRef<HTMLDivElement>(null)

  const append = (s: string) => setLog((p) => [...p, s])
  const replaceAt = (idx: number, s: string) =>
    setLog((p) => {
      const next = [...p]
      next[idx] = s
      return next
    })
  const appendDelta = (itemId: string, delta: string) => {
    setLog((p) => {
      const idx = messages.current.get(itemId)
      if (idx !== undefined) {
        const next = [...p]
        next[idx] = next[idx] + delta
        return next
      }
      messages.current.set(itemId, p.length)
      return [...p, delta]
    })
  }

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
            handleEvent(msg.method, msg.params)
          }
        } catch {
          append(line)
        }
      }
    })
    window.zspark.onStderr((s) => append(`[stderr] ${s.trim()}`))
    window.zspark.onExit((c) => append(`\n[codex exited: ${c}]`))

    function handleEvent(method: string, params: any) {
      switch (method) {
        case 'item/agentMessage/delta':
          appendDelta(params.itemId, params.delta ?? '')
          return
        case 'item/started':
        case 'item/completed': {
          const item = params?.item
          if (!item) return
          if (item.type === 'userMessage') {
            const txt = (item.content ?? []).map((c: any) => c.text ?? '').join('')
            if (method === 'item/started') append(`> ${txt}`)
            return
          }
          if (item.type === 'agentMessage' && method === 'item/completed') {
            const txt = (item.content ?? item.text ?? '')
            if (typeof txt === 'string' && txt && !messages.current.has(item.id)) {
              messages.current.set(item.id, log.length)
              append(txt)
            }
            return
          }
          if (item.type === 'reasoning') return // hide reasoning blobs
          return
        }
        case 'turn/started':
          return
        case 'turn/completed':
          append('') // blank line
          return
        case 'thread/status/changed':
        case 'thread/tokenUsage/updated':
        case 'account/rateLimits/updated':
        case 'thread/started':
          return
        case 'mcpServer/startupStatus/updated':
          if (params?.status === 'failed') append(`⚠ MCP ${params.name}: ${params.error}`)
          return
        case 'configWarning':
          append(`⚠ ${params?.summary ?? ''}`)
          return
        default:
          // swallow
          return
      }
    }

    ;(async () => {
      try {
        const init = await send('initialize', {
          clientInfo: { name: 'zspark-desktop', version: '0.0.1' }
        })
        if (init.error) {
          append(`✗ initialize: ${init.error.message}`)
          return
        }
        const t = await send('thread/start', {})
        const tid = t.result?.thread?.id ?? null
        setThread(tid)
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
    setInput('')
    try {
      const res = await send('turn/start', {
        threadId: thread,
        input: [{ type: 'text', text, textElements: [] }]
      })
      if (res.error) append(`✗ turn failed: ${res.error.message}`)
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
