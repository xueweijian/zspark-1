import React, { useEffect, useRef, useState } from 'react'
import {
  IconNewChat, IconSearch, IconSkills, IconPlugins, IconAutomations,
  IconProject, IconSend, IconClose, IconSettings
} from './icons'

declare global {
  interface Window {
    zspark: {
      send: (line: string) => Promise<boolean>
      restart: () => Promise<boolean>
      getSettings: () => Promise<{ provider?: { baseUrl: string; apiKey: string; model: string; wireApi: 'responses' | 'chat' } }>
      saveSettings: (s: any) => Promise<boolean>
      onStdout: (cb: (s: string) => void) => void
      onStderr: (cb: (s: string) => void) => void
      onExit: (cb: (code: number | null) => void) => void
      onSpawned: (cb: () => void) => void
    }
  }
}

const sidebarItems = [
  { label: 'New chat', Icon: IconNewChat },
  { label: 'Search', Icon: IconSearch },
  { label: 'Skills', Icon: IconSkills },
  { label: 'Plugins', Icon: IconPlugins },
  { label: 'Automations', Icon: IconAutomations }
]

const starters = [
  { t: 'Draft a status update', d: 'Summarize this week, write a Teams message.' },
  { t: 'Review a document', d: 'Open a file and surface the key risks.' },
  { t: 'Spin up a deck outline', d: 'Five-slide outline for an exec readout.' },
  { t: 'Automate a workflow', d: 'Schedule a recurring task from natural language.' }
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

type Kind = 'user' | 'assistant'
interface Msg { id: string; kind: Kind; text: string }

type ToastKind = 'info' | 'warn' | 'error'
interface Toast { id: string; kind: ToastKind; text: string }

interface ProviderForm {
  baseUrl: string
  apiKey: string
  model: string
  wireApi: 'responses' | 'chat'
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<ProviderForm>({ baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', wireApi: 'responses' })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    window.zspark.getSettings().then((s) => {
      if (s.provider) setForm((prev) => ({ ...prev, ...s.provider }))
    })
  }, [])
  const save = async () => {
    setSaving(true)
    await window.zspark.saveSettings({ provider: form })
    setSaving(false)
    onClose()
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Model provider</h2>
        <p className="modal-hint">Standard OpenAI-compatible endpoint. zspark talks to it via Responses API or Chat Completions.</p>
        <label>Base URL<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></label>
        <label>API Key<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." /></label>
        <label>Model<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4o-mini" /></label>
        <label>Wire API
          <select value={form.wireApi} onChange={(e) => setForm({ ...form, wireApi: e.target.value as 'responses' | 'chat' })}>
            <option value="responses">Responses API (recommended)</option>
            <option value="chat">Chat Completions</option>
          </select>
        </label>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={saving || !form.apiKey || !form.baseUrl || !form.model}>{saving ? 'Saving…' : 'Save & restart'}</button>
        </div>
      </div>
    </div>
  )
}

export function App() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [input, setInput] = useState('')
  const [thread, setThread] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const turnAgentMsg = useRef<Map<string, string>>(new Map())
  const buf = useRef('')
  const streamRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const add = (m: Msg) => setMsgs((p) => [...p, m])
  const appendTo = (id: string, delta: string) =>
    setMsgs((p) => p.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)))
  const toast = (kind: ToastKind, text: string) => {
    const id = `t-${Date.now()}-${Math.random()}`
    setToasts((p) => [...p, { id, kind, text }])
    if (kind !== 'error') setTimeout(() => dismiss(id), 4000)
  }
  const dismiss = (id: string) => setToasts((p) => p.filter((t) => t.id !== id))

  useEffect(() => {
    function handle(method: string, params: any) {
      switch (method) {
        case 'item/agentMessage/delta': {
          const turnId = params.turnId as string
          let localId = turnAgentMsg.current.get(turnId)
          if (!localId) {
            localId = `agent-${turnId}`
            turnAgentMsg.current.set(turnId, localId)
            add({ id: localId, kind: 'assistant', text: '' })
          }
          appendTo(localId, params.delta ?? '')
          return
        }
        case 'item/started':
        case 'item/completed': {
          const item = params?.item
          if (!item) return
          if (item.type === 'userMessage' && method === 'item/started') {
            const txt = (item.content ?? []).map((c: any) => c.text ?? '').join('')
            add({ id: `user-${item.id}`, kind: 'user', text: txt })
            return
          }
          if (item.type === 'agentMessage' && method === 'item/completed') {
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
        case 'turn/completed':
          setStreaming(false)
          for (const k of [...turnAgentMsg.current.keys()]) turnAgentMsg.current.delete(k)
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
            if (msg.error && msg.error.message !== 'Not initialized') {
              toast('error', msg.error.message)
            }
          } else if (msg.method) {
            handle(msg.method, msg.params)
          }
        } catch { /* ignore */ }
      }
    })
    window.zspark.onStderr(() => { /* swallow */ })
    window.zspark.onExit(() => {
      setReady(false); setStreaming(false); setThread(null)
    })

    const handshake = async () => {
      try {
        const init = await send('initialize', { clientInfo: { name: 'zspark-desktop', version: '0.0.1' } })
        if (init.error) { toast('error', `Init: ${init.error.message}`); return }
        const t = await send('thread/start', {})
        const tid = t.result?.thread?.id ?? null
        setThread(tid); setReady(true)
      } catch (e: any) {
        toast('error', e?.message ?? String(e))
      }
    }
    window.zspark.onSpawned(() => { handshake() })
    handshake()
  }, [])

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [input])

  const submit = async (override?: string) => {
    const text = (override ?? input).trim()
    if (!text || !ready || streaming) return
    if (!override) setInput('')
    try {
      const res = await send('turn/start', { threadId: thread, input: [{ type: 'text', text, textElements: [] }] })
      if (res.error) toast('error', res.error.message)
    } catch (e: any) {
      toast('error', e?.message ?? String(e))
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  const statusClass = ready ? (streaming ? 'streaming' : 'live') : 'off'
  const statusText = ready ? (streaming ? 'streaming' : 'ready') : 'connecting'

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">z</div>zspark</div>
        {sidebarItems.map(({ label, Icon }) => (
          <div className={`nav-item${label === 'New chat' ? ' active' : ''}`} key={label}>
            <Icon /><span>{label}</span>
          </div>
        ))}
        <h3>Projects</h3>
        <div className="nav-item active"><IconProject /><span>zspark</span></div>
      </aside>

      <main className="chat">
        <div className="chat-header">
          <div className="left">Workspace</div>
          <div className="right">
            <button className="header-btn" onClick={() => setShowSettings(true)}>
              <IconSettings /> Provider
            </button>
            <span className={`status-dot ${statusClass}`}>{statusText}</span>
          </div>
        </div>

        <div className="chat-stream" ref={streamRef}>
          {msgs.length === 0 ? (
            <div className="empty">
              <div className="h">What should we build?</div>
              <div className="sub">Draft, review, automate. zspark works as your daily co-worker — connected to your tools, governed by your policies.</div>
              <div className="grid">
                {starters.map((s) => (
                  <div className="card" key={s.t} onClick={() => submit(s.d)}>
                    <div className="t">{s.t}</div>
                    <div className="d">{s.d}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            msgs.map((m) => <div key={m.id} className={`bubble ${m.kind}`}>{m.text}</div>)
          )}
        </div>

        <div className="chat-input-wrap">
          <div className="chat-input">
            <textarea
              ref={taRef}
              rows={1}
              placeholder={ready ? 'Ask zspark anything…' : 'Connecting…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              disabled={!ready}
            />
            <button className="send-btn" onClick={() => submit()} disabled={!ready || streaming || !input.trim()} aria-label="Send">
              <IconSend />
            </button>
          </div>
        </div>
      </main>

      <aside className="right">
        <div className="right-section">
          <h4>Session</h4>
          <div className="kv"><span className="k">Thread</span><span className="v">{thread ? thread.slice(0, 8) : '—'}</span></div>
          <div className="kv"><span className="k">Status</span><span className="v"><span className={`pill ${ready ? '' : 'off'}`}>{ready ? 'live' : 'offline'}</span></span></div>
        </div>
        <div className="right-section">
          <h4>Runtime</h4>
          <div className="kv"><span className="k">Sandbox</span><span className="v">Seatbelt · AppContainer</span></div>
          <div className="kv"><span className="k">Auth</span><span className="v">Entra ID (CN)</span></div>
          <div className="kv"><span className="k">Collab</span><span className="v">143.64.174.225</span></div>
        </div>
      </aside>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div className="body">{t.text}</div>
            <button className="close" onClick={() => dismiss(t.id)} aria-label="Dismiss"><IconClose /></button>
          </div>
        ))}
      </div>
    </div>
  )
}
