import React, { useEffect, useRef, useState } from 'react'
import {
  IconNewChat, IconSearch, IconSkills, IconPlugins, IconAutomations,
  IconProject, IconSend, IconClose, IconSettings, IconChevron,
  IconBrain, IconTerminal, IconFile, IconTool, IconGlobe
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

type ActivityKind = 'reasoning' | 'command' | 'file' | 'tool' | 'web'
interface Activity {
  id: string
  kind: ActivityKind
  title: string
  detail?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
}

type Block =
  | { type: 'user'; id: string; text: string }
  | { type: 'agent'; id: string; text: string }
  | { type: 'turn'; id: string; turnId: string; activities: Activity[]; collapsed: boolean; finalMessageId?: string; startedAt: number; endedAt?: number }

type ToastKind = 'info' | 'warn' | 'error'
interface Toast { id: string; kind: ToastKind; text: string }

interface ProviderForm { baseUrl: string; apiKey: string; model: string; wireApi: 'responses' | 'chat' }

function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function actIcon(k: ActivityKind) {
  switch (k) {
    case 'reasoning': return <IconBrain />
    case 'command': return <IconTerminal />
    case 'file': return <IconFile />
    case 'tool': return <IconTool />
    case 'web': return <IconGlobe />
  }
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<ProviderForm>({ baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', wireApi: 'responses' })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    window.zspark.getSettings().then((s) => { if (s.provider) setForm((p) => ({ ...p, ...s.provider })) })
  }, [])
  const save = async () => {
    setSaving(true)
    await window.zspark.saveSettings({ provider: form })
    setSaving(false); onClose()
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Model provider</h2>
        <p className="modal-hint">Standard OpenAI-compatible endpoint. Talks via Responses API or Chat Completions.</p>
        <label>Base URL<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
        <label>API Key<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." /></label>
        <label>Model<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
        <label>Wire API
          <select value={form.wireApi} onChange={(e) => setForm({ ...form, wireApi: e.target.value as any })}>
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
  const [blocks, setBlocks] = useState<Block[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [input, setInput] = useState('')
  const [thread, setThread] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // Track current turn block id for incoming events
  const currentTurn = useRef<{ turnId: string; blockId: string } | null>(null)
  // Map agent itemId (delta or completed) -> agent block id, scoped per turn
  const agentForTurn = useRef<Map<string, string>>(new Map())
  // Map item id -> activity id
  const itemActivity = useRef<Map<string, string>>(new Map())
  const buf = useRef('')
  const streamRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const toast = (kind: ToastKind, text: string) => {
    const id = `t-${Date.now()}-${Math.random()}`
    setToasts((p) => [...p, { id, kind, text }])
    if (kind !== 'error') setTimeout(() => dismiss(id), 4000)
  }
  const dismiss = (id: string) => setToasts((p) => p.filter((t) => t.id !== id))

  const updateTurn = (turnId: string, fn: (t: Extract<Block, { type: 'turn' }>) => Extract<Block, { type: 'turn' }>) => {
    setBlocks((bs) => bs.map((b) => (b.type === 'turn' && b.turnId === turnId ? fn(b) : b)))
  }
  const updateActivity = (turnId: string, actId: string, patch: Partial<Activity>) => {
    updateTurn(turnId, (t) => ({ ...t, activities: t.activities.map((a) => (a.id === actId ? { ...a, ...patch } : a)) }))
  }
  const ensureActivity = (turnId: string, itemId: string, init: Omit<Activity, 'id' | 'status' | 'startedAt'>) => {
    let actId = itemActivity.current.get(itemId)
    if (actId) return actId
    actId = `a-${itemId}`
    itemActivity.current.set(itemId, actId)
    updateTurn(turnId, (t) => ({ ...t, activities: [...t.activities, { id: actId!, status: 'running', startedAt: Date.now(), ...init }] }))
    return actId
  }
  const appendActivityDetail = (turnId: string, itemId: string, delta: string) => {
    const actId = itemActivity.current.get(itemId)
    if (!actId) return
    updateTurn(turnId, (t) => ({ ...t, activities: t.activities.map((a) => (a.id === actId ? { ...a, detail: (a.detail ?? '') + delta } : a)) }))
  }
  const appendAgentText = (turnId: string, blockId: string, delta: string) => {
    setBlocks((bs) => bs.map((b) => (b.type === 'agent' && b.id === blockId ? { ...b, text: b.text + delta } : b)))
    // Also link the turn block to this agent block as its final message.
    updateTurn(turnId, (t) => (t.finalMessageId ? t : { ...t, finalMessageId: blockId }))
  }

  useEffect(() => {
    function handle(method: string, params: any) {
      switch (method) {
        case 'turn/started': {
          setStreaming(true)
          const turnId = params.turnId as string
          const blockId = `turn-${turnId}`
          currentTurn.current = { turnId, blockId }
          agentForTurn.current.clear()
          setBlocks((bs) => [...bs, { type: 'turn', id: blockId, turnId, activities: [], collapsed: false, startedAt: Date.now() }])
          return
        }
        case 'turn/completed': {
          setStreaming(false)
          const turnId = params.turnId as string
          updateTurn(turnId, (t) => ({ ...t, endedAt: Date.now(), collapsed: true }))
          currentTurn.current = null
          return
        }
        case 'item/agentMessage/delta': {
          const turnId = params.turnId as string
          const cur = currentTurn.current
          if (!cur || cur.turnId !== turnId) return
          let agentBlockId = agentForTurn.current.get(turnId)
          if (!agentBlockId) {
            agentBlockId = `agent-${turnId}`
            agentForTurn.current.set(turnId, agentBlockId)
            setBlocks((bs) => [...bs, { type: 'agent', id: agentBlockId!, text: '' }])
          }
          appendAgentText(turnId, agentBlockId, params.delta ?? '')
          return
        }
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta': {
          const turnId = params.turnId as string
          if (!currentTurn.current || currentTurn.current.turnId !== turnId) return
          const itemId = params.itemId as string
          ensureActivity(turnId, itemId, { kind: 'reasoning', title: 'Thinking' })
          appendActivityDetail(turnId, itemId, params.delta ?? '')
          return
        }
        case 'item/started':
        case 'item/completed': {
          const item = params?.item
          if (!item) return
          const turnId = params.turnId as string
          if (item.type === 'userMessage') {
            if (method === 'item/started') {
              const txt = (item.content ?? []).map((c: any) => c.text ?? '').join('')
              setBlocks((bs) => [...bs, { type: 'user', id: `user-${item.id}`, text: txt }])
            }
            return
          }
          if (item.type === 'agentMessage' && method === 'item/completed') {
            // If we already streamed via deltas, ignore (delta path owns the text).
            if (agentForTurn.current.has(turnId)) return
            const txt = item.text ?? ''
            if (txt) {
              const blockId = `agent-${turnId}-final`
              agentForTurn.current.set(turnId, blockId)
              setBlocks((bs) => [...bs, { type: 'agent', id: blockId, text: txt }])
              updateTurn(turnId, (t) => ({ ...t, finalMessageId: blockId }))
            }
            return
          }
          if (item.type === 'reasoning') {
            // Use existing activity (created by deltas) — finalize it on completion
            if (method === 'item/completed') {
              const itemId = item.id as string
              if (itemActivity.current.has(itemId)) {
                updateActivity(turnId, itemActivity.current.get(itemId)!, { status: 'done', endedAt: Date.now(), title: 'Thought' })
              }
            }
            return
          }
          if (item.type === 'commandExecution') {
            const itemId = item.id as string
            const command = item.command ?? ''
            const short = command.length > 80 ? command.slice(0, 77) + '…' : command
            if (method === 'item/started') {
              ensureActivity(turnId, itemId, { kind: 'command', title: short })
            } else {
              const status: Activity['status'] =
                item.status === 'completed' ? 'done' :
                item.status === 'failed' ? 'failed' : 'done'
              if (!itemActivity.current.has(itemId)) ensureActivity(turnId, itemId, { kind: 'command', title: short })
              updateActivity(turnId, itemActivity.current.get(itemId)!, {
                status, endedAt: Date.now(),
                detail: item.aggregated_output ?? item.aggregatedOutput ?? undefined,
                title: short
              })
            }
            return
          }
          if (item.type === 'fileChange') {
            const itemId = item.id as string
            const changes = item.changes ?? []
            const title = `${changes.length} file${changes.length === 1 ? '' : 's'} changed`
            if (method === 'item/started') ensureActivity(turnId, itemId, { kind: 'file', title })
            else {
              if (!itemActivity.current.has(itemId)) ensureActivity(turnId, itemId, { kind: 'file', title })
              updateActivity(turnId, itemActivity.current.get(itemId)!, { status: 'done', endedAt: Date.now(), title })
            }
            return
          }
          if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
            const itemId = item.id as string
            const title = item.tool ? `${item.tool}` : 'tool call'
            if (method === 'item/started') ensureActivity(turnId, itemId, { kind: 'tool', title })
            else {
              if (!itemActivity.current.has(itemId)) ensureActivity(turnId, itemId, { kind: 'tool', title })
              updateActivity(turnId, itemActivity.current.get(itemId)!, { status: item.status === 'failed' ? 'failed' : 'done', endedAt: Date.now() })
            }
            return
          }
          if (item.type === 'webSearch') {
            const itemId = item.id as string
            const title = item.query ? `Searched “${item.query}”` : 'Web search'
            if (method === 'item/started') ensureActivity(turnId, itemId, { kind: 'web', title })
            else {
              if (!itemActivity.current.has(itemId)) ensureActivity(turnId, itemId, { kind: 'web', title })
              updateActivity(turnId, itemActivity.current.get(itemId)!, { status: 'done', endedAt: Date.now() })
            }
            return
          }
          return
        }
        default: return
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
            if (msg.error && msg.error.message !== 'Not initialized') toast('error', msg.error.message)
          } else if (msg.method) {
            handle(msg.method, msg.params)
          }
        } catch { /* ignore */ }
      }
    })
    window.zspark.onStderr(() => {})
    window.zspark.onExit(() => { setReady(false); setStreaming(false); setThread(null) })

    const handshake = async () => {
      try {
        const init = await send('initialize', { clientInfo: { name: 'zspark-desktop', version: '0.0.1' } })
        if (init.error) { toast('error', init.error.message); return }
        const t = await send('thread/start', {})
        const tid = t.result?.thread?.id ?? null
        setThread(tid); setReady(true)
      } catch (e: any) { toast('error', e?.message ?? String(e)) }
    }
    window.zspark.onSpawned(() => { handshake() })
    handshake()
  }, [])

  useEffect(() => { streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' }) }, [blocks])
  useEffect(() => {
    const ta = taRef.current; if (!ta) return
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [input])

  const submit = async (override?: string) => {
    const text = (override ?? input).trim()
    if (!text || !ready || streaming) return
    if (!override) setInput('')
    try {
      const res = await send('turn/start', { threadId: thread, input: [{ type: 'text', text, textElements: [] }] })
      if (res.error) toast('error', res.error.message)
    } catch (e: any) { toast('error', e?.message ?? String(e)) }
  }
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }
  const toggleTurn = (turnId: string) =>
    updateTurn(turnId, (t) => ({ ...t, collapsed: !t.collapsed }))

  const statusClass = ready ? (streaming ? 'streaming' : 'live') : 'off'
  const statusText = ready ? (streaming ? 'streaming' : 'ready') : 'connecting'

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">z</div>zspark</div>
        {sidebarItems.map(({ label, Icon }) => (
          <div className={`nav-item${label === 'New chat' ? ' active' : ''}`} key={label}><Icon /><span>{label}</span></div>
        ))}
        <h3>Projects</h3>
        <div className="nav-item active"><IconProject /><span>zspark</span></div>
      </aside>

      <main className="chat">
        <div className="chat-header">
          <div className="left">Workspace</div>
          <div className="right">
            <button className="header-btn" onClick={() => setShowSettings(true)}><IconSettings /> Provider</button>
            <span className={`status-dot ${statusClass}`}>{statusText}</span>
          </div>
        </div>

        <div className="chat-stream" ref={streamRef}>
          {blocks.length === 0 ? (
            <div className="empty">
              <div className="h">What should we build?</div>
              <div className="sub">Draft, review, automate. zspark works as your daily co-worker.</div>
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
            blocks.map((b) => {
              if (b.type === 'user') return <div key={b.id} className="bubble user">{b.text}</div>
              if (b.type === 'agent') return <div key={b.id} className="bubble assistant">{b.text}</div>
              const dur = (b.endedAt ?? Date.now()) - b.startedAt
              const running = !b.endedAt
              return (
                <div key={b.id} className={`activity-card${b.collapsed ? ' collapsed' : ''}${running ? ' running' : ''}`}>
                  <div className="activity-head" onClick={() => toggleTurn(b.turnId)}>
                    <div className="head-left">
                      <span className={`spinner${running ? ' spin' : ''}`} />
                      <span className="head-title">{running ? 'Working…' : `Worked for ${fmtDuration(dur)}`}</span>
                      {!running && <span className="head-meta">{b.activities.length} step{b.activities.length === 1 ? '' : 's'}</span>}
                    </div>
                    <button className="chev" aria-label="Toggle"><IconChevron /></button>
                  </div>
                  {!b.collapsed && (
                    <div className="activity-body">
                      {b.activities.length === 0 ? (
                        <div className="empty-act">Preparing…</div>
                      ) : b.activities.map((a) => (
                        <div key={a.id} className={`act act-${a.kind} act-${a.status}`}>
                          <div className="act-icon">{actIcon(a.kind)}</div>
                          <div className="act-meat">
                            <div className="act-title">{a.title}</div>
                            {a.detail && a.kind === 'reasoning' && (
                              <div className="act-detail mono">{a.detail.slice(-600)}</div>
                            )}
                            {a.detail && a.kind === 'command' && (
                              <pre className="act-detail mono">{a.detail.slice(-800)}</pre>
                            )}
                          </div>
                          <div className="act-status">
                            {a.status === 'running' ? '· · ·' :
                             a.status === 'failed' ? 'failed' :
                             a.endedAt ? fmtDuration(a.endedAt - a.startedAt) : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="chat-input-wrap">
          <div className="chat-input">
            <textarea ref={taRef} rows={1} placeholder={ready ? 'Ask zspark anything…' : 'Connecting…'}
              value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={!ready} />
            <button className="send-btn" onClick={() => submit()} disabled={!ready || streaming || !input.trim()} aria-label="Send"><IconSend /></button>
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
