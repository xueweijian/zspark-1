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

const sidebarItems = [
  { label: 'New chat', icon: '+' },
  { label: 'Search', icon: '⌕' },
  { label: 'Skills', icon: '◆' },
  { label: 'Plugins', icon: '◇' },
  { label: 'Automations', icon: '↻' }
]

let nextId = 1
const newId = () => nextId++

interface Pending { resolve: (msg: any) => void; reject: (err: any) => void }
const pending = new Map<number, Pending>()

function send(method: string, params: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const id = newId()
    pending.set(id, { resolve, reject })
    window.zspark.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

type Kind = 'user' | 'assistant' | 'system' | 'warn' | 'error'
interface Msg { id: string; kind: Kind; text: string }

export function App() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [thread, setThread] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [streaming, setStreaming] = useState(false)
  // Track which agentMessage IDs we've already rendered (delta or completed)
  const seenAgent = useRef<Set<string>>(new Set())
  // turnId -> currently streaming agentMessage local id
  const turnAgentMsg = useRef<Map<string, string>>(new Map())
  const buf = useRef('')
  const streamRef = useRef<HTMLDivElement>(null)

  const add = (m: Msg) => setMsgs((p) => [...p, m])
  const appendTo = (id: string, delta: string) =>
    setMsgs((p) => p.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)))

  useEffect(() => {
    function handle(method: string, params: any) {
      switch (method) {
        case 'item/agentMessage/delta': {
          const turnId = params.turnId as string
          let localId = turnAgentMsg.current.get(turnId)
          if (!localId) {
            localId = `agent-${turnId}`
            turnAgentMsg.current.set(turnId, localId)
            seenAgent.current.add(localId)
            add({ id: localId, kind: 'assistant', text: '' })
          }
          appendTo(localId, params.delta ?? '')
          return
        }
        case 'item/started':
        case 'item/completed': {
          const item = params?.item
          if (!item) return
          if (item.type === 'userMessage') {
            if (method === 'item/started') {
              const txt = (item.content ?? []).map((c: any) => c.text ?? '').join('')
              add({ id: `user-${item.id}`, kind: 'user', text: txt })
            }
            return
          }
          if (item.type === 'agentMessage' && method === 'item/completed') {
            // If we already streamed via deltas this turn, skip the duplicate
            const turnId = params.turnId as string
            if (turnAgentMsg.current.has(turnId)) return
            const txt = Array.isArray(item.content)
              ? item.content.map((c: any) => c.text ?? '').join('')
              : (item.text ?? '')
            if (txt) add({ id: `agent-${item.id}`, kind: 'assistant', text: txt })
            return
          }
          return
        }
        case 'turn/started':
          setStreaming(true)
          return
        case 'turn/completed': {
          setStreaming(false)
          // clear the per-turn assistant tracker
          for (const k of [...turnAgentMsg.current.keys()]) turnAgentMsg.current.delete(k)
          return
        }
        case 'mcpServer/startupStatus/updated':
          if (params?.status === 'failed') add({ id: `mcp-${params.name}`, kind: 'warn', text: `MCP ${params.name}: ${params.error}` })
          return
        case 'configWarning':
          if (params?.summary) add({ id: 'cfg', kind: 'warn', text: params.summary.split('\n')[0] })
          return
        default:
          return
      }
    }

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
            if (msg.error) add({ id: `err-${msg.id}`, kind: 'error', text: `${msg.error.code}: ${msg.error.message}` })
          } else if (msg.method) {
            handle(msg.method, msg.params)
          }
        } catch {
          /* ignore */
        }
      }
    })
    window.zspark.onStderr((s) => add({ id: `stderr-${Math.random()}`, kind: 'error', text: s.trim() }))
    window.zspark.onExit((c) => add({ id: 'exit', kind: 'error', text: `codex exited: ${c}` }))

    ;(async () => {
      try {
        const init = await send('initialize', { clientInfo: { name: 'zspark-desktop', version: '0.0.1' } })
        if (init.error) { add({ id: 'init', kind: 'error', text: init.error.message }); return }
        const t = await send('thread/start', {})
        const tid = t.result?.thread?.id ?? null
        setThread(tid); setReady(true)
      } catch (e: any) {
        add({ id: 'init', kind: 'error', text: e?.message ?? String(e) })
      }
    })()
  }, [])

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  const submit = async () => {
    const text = input.trim()
    if (!text || !ready || streaming) return
    setInput('')
    try {
      const res = await send('turn/start', { threadId: thread, input: [{ type: 'text', text, textElements: [] }] })
      if (res.error) add({ id: `te-${Date.now()}`, kind: 'error', text: res.error.message })
    } catch (e: any) {
      add({ id: `te-${Date.now()}`, kind: 'error', text: e?.message ?? String(e) })
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="dot" />zspark</div>
        {sidebarItems.map((it) => (
          <div className="item" key={it.label}><span style={{ width: 14, color: '#a8a29e' }}>{it.icon}</span>{it.label}</div>
        ))}
        <h3>Projects</h3>
        <div className="item active">zspark</div>
      </aside>

      <main className="chat">
        <div className="chat-header">
          <span>Workspace</span>
          <span className="badge">{ready ? (streaming ? 'streaming…' : 'ready') : 'connecting…'}</span>
        </div>
        <div className="chat-stream" ref={streamRef}>
          {msgs.length === 0 ? (
            <div className="empty">
              <div className="h">What should we build?</div>
              <div>Ask zspark to draft a deck, summarize a doc, or run a workflow.</div>
            </div>
          ) : (
            msgs.map((m) => <div key={m.id} className={`bubble ${m.kind}`}>{m.text}</div>)
          )}
        </div>
        <div className="chat-input-wrap">
          <div className="chat-input">
            <textarea
              rows={1}
              placeholder={ready ? 'Ask zspark anything. ⏎ to send, ⇧⏎ for newline' : 'Connecting to codex…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              disabled={!ready}
            />
            <button onClick={submit} disabled={!ready || streaming || !input.trim()}>Send</button>
          </div>
        </div>
      </main>

      <aside className="right">
        <div>
          <h4>Session</h4>
          <div className="row"><span className="k">Thread</span><span className="v">{thread ? thread.slice(0, 8) : '—'}</span></div>
          <div className="row"><span className="k">Status</span><span className="v"><span className={`pill ${ready ? '' : 'off'}`}>{ready ? 'live' : 'offline'}</span></span></div>
        </div>
        <div>
          <h4>Runtime</h4>
          <div className="row"><span className="k">Sandbox</span><span className="v">Seatbelt / AppContainer</span></div>
          <div className="row"><span className="k">Auth</span><span className="v">Entra ID (CN)</span></div>
          <div className="row"><span className="k">Collab</span><span className="v">143.64.174.225:8787</span></div>
        </div>
      </aside>
    </div>
  )
}
