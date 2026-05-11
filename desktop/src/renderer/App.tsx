import React, { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
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

type Panel = null | 'search' | 'skills' | 'plugins' | 'automations' | 'history'

interface ThreadSummary { id: string; preview?: string; createdAt?: number; updatedAt?: number; name?: string | null }
interface SkillMeta { name: string; description?: string }

function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

marked.setOptions({ gfm: true, breaks: true })

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || '', { async: false }) as string), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
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
    <div className="modal-bg">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Model provider</h2>
          <button className="modal-x" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        <p className="modal-hint">Standard OpenAI-compatible endpoint. Talks via Responses API.</p>
        <label>Base URL<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
        <label>API Key<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." /></label>
        <label>Model<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
        <label>Wire API
          <select value={form.wireApi} onChange={(e) => setForm({ ...form, wireApi: e.target.value as any })}>
            <option value="responses">Responses API</option>
            <option value="chat">Chat Completions (via local bridge)</option>
          </select>
          <span className="modal-hint" style={{ marginTop: 4 }}>Chat Completions runs through zspark's in-process Chat↔Responses bridge — works with vLLM, SGLang, Ollama, AzureChatGPT, etc. Tool calls and reasoning_content are translated.</span>
        </label>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={saving || !form.apiKey || !form.baseUrl || !form.model}>{saving ? 'Saving…' : 'Save & restart'}</button>
        </div>
      </div>
    </div>
  )
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="drawer-bg">
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="t">{title}</div>
          <button className="modal-x" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        <div className="drawer-body">{children}</div>
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
  const [panel, setPanel] = useState<Panel>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [searchQuery, setSearchQuery] = useState('')
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
          // Pre-create a Thinking activity so users see immediate feedback
          // even when the upstream model doesn't stream reasoning deltas.
          const thinkingId = `thinking-${turnId}`
          itemActivity.current.set(thinkingId, thinkingId)
          setBlocks((bs) => [
            ...bs,
            {
              type: 'turn', id: blockId, turnId, collapsed: false, startedAt: Date.now(),
              activities: [{ id: thinkingId, kind: 'reasoning', title: 'Thinking', status: 'running', startedAt: Date.now() }]
            }
          ])
          return
        }
        case 'turn/completed': {
          setStreaming(false)
          const turnId = params.turnId as string
          updateTurn(turnId, (t) => {
            // Mark any still-running activities done at end of turn (incl. our placeholder Thinking)
            const acts = t.activities.map((a) => (a.status === 'running' ? { ...a, status: 'done' as const, endedAt: Date.now(), title: a.kind === 'reasoning' ? 'Thought' : a.title } : a))
            return { ...t, endedAt: Date.now(), collapsed: true, activities: acts }
          })
          currentTurn.current = null
          return
        }
        case 'error':
        case 'warning': {
          // Codex pushes a top-level {"method":"error"} when the upstream
          // provider rejects the request body (e.g. vLLM choking on the
          // codex Responses API shape). Surface it instead of swallowing.
          if (method === 'warning') {
            const wm = params?.message ?? ''
            if (wm) toast('warn', wm)
            return
          }
          setStreaming(false)
          const cur = currentTurn.current
          if (cur) updateTurn(cur.turnId, (t) => ({ ...t, endedAt: Date.now() }))
          let msg = params?.error?.message ?? params?.message ?? 'Provider error'
          try { const inner = JSON.parse(msg); msg = inner?.error?.message ?? msg } catch {}
          if (msg.length > 500) msg = msg.slice(0, 500) + '…'
          toast('error', msg)
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
          // Route reasoning deltas into the placeholder Thinking activity so
          // we have one accumulator regardless of how many reasoning items
          // the model produces.
          const placeholderId = `thinking-${turnId}`
          if (!itemActivity.current.has(placeholderId)) {
            ensureActivity(turnId, placeholderId, { kind: 'reasoning', title: 'Thinking' })
          }
          appendActivityDetail(turnId, placeholderId, params.delta ?? '')
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
            // The completed event carries the authoritative full text. Some
            // providers stream only the first chunk via deltas (or send no
            // deltas at all) and put the rest in the final completed item.
            // Always overwrite the bubble with the canonical text.
            const txt = item.text ?? (Array.isArray(item.content) ? item.content.map((c: any) => c.text ?? '').join('') : '')
            if (!txt) return
            const existing = agentForTurn.current.get(turnId)
            if (existing) {
              setBlocks((bs) => bs.map((b) => (b.type === 'agent' && b.id === existing ? { ...b, text: txt } : b)))
            } else {
              const blockId = `agent-${turnId}-final`
              agentForTurn.current.set(turnId, blockId)
              setBlocks((bs) => [...bs, { type: 'agent', id: blockId, text: txt }])
            }
            updateTurn(turnId, (t) => ({ ...t, finalMessageId: agentForTurn.current.get(turnId) }))
            return
          }
          if (item.type === 'reasoning') {
            // If the upstream returned reasoning as a single completed item
            // (no deltas), append the summary/content to the placeholder.
            if (method === 'item/completed') {
              const placeholderId = `thinking-${turnId}`
              const summary = Array.isArray(item.summary) ? item.summary.join('\n\n') : ''
              const content = Array.isArray(item.content) ? item.content.join('\n\n') : ''
              const txt = (summary + (summary && content ? '\n\n' : '') + content).trim()
              if (txt) appendActivityDetail(turnId, placeholderId, txt)
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

  // Refresh thread list when ready, and on each turn boundary (start/end)
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const refresh = async () => {
      try {
        const r = await send('thread/list', { limit: 50 })
        if (!cancelled) setThreads(r.result?.data ?? [])
      } catch {}
    }
    refresh()
    return () => { cancelled = true }
  }, [ready, thread])

  const newChat = async () => {
    if (!ready) return
    setBlocks([])
    try {
      const t = await send('thread/start', {})
      setThread(t.result?.thread?.id ?? null)
    } catch (e: any) { toast('error', e?.message ?? String(e)) }
  }
  const switchThread = async (id: string) => {
    if (!ready) return
    setBlocks([])
    try {
      const t = await send('thread/resume', { threadId: id })
      setThread(t.result?.thread?.id ?? id)
      setPanel(null)
      // Replay items into bubbles (best-effort: preview + saved messages)
      const items = await send('thread/turns/items/list', { threadId: id, limit: 200 })
      const list = items.result?.items ?? []
      const replay: Block[] = []
      for (const it of list) {
        if (it?.type === 'userMessage') {
          const txt = (it.content ?? []).map((c: any) => c.text ?? '').join('')
          replay.push({ type: 'user', id: `replay-u-${it.id}`, text: txt })
        } else if (it?.type === 'agentMessage') {
          const txt = it.text ?? ''
          if (txt) replay.push({ type: 'agent', id: `replay-a-${it.id}`, text: txt })
        }
      }
      setBlocks(replay)
    } catch (e: any) { toast('error', e?.message ?? String(e)) }
  }
  const openPanel = async (p: Panel) => {
    setPanel(p)
    if (!ready) return
    if (p === 'history' || p === 'search') {
      try {
        const r = await send('thread/list', { limit: 50 })
        setThreads(r.result?.data ?? [])
      } catch {}
    } else if (p === 'skills') {
      try {
        const r = await send('skills/list', {})
        const all: SkillMeta[] = []
        for (const e of r.result?.data ?? []) for (const s of e.skills ?? []) all.push({ name: s.name, description: s.description })
        setSkills(all)
      } catch {}
    }
  }
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
        <div className="nav-item active" onClick={newChat}><IconNewChat /><span>New chat</span></div>
        <div className="nav-item" onClick={() => openPanel('search')}><IconSearch /><span>Search</span></div>
        <div className="nav-item" onClick={() => openPanel('skills')}><IconSkills /><span>Skills</span></div>
        <div className="nav-item" onClick={() => openPanel('plugins')}><IconPlugins /><span>Plugins</span></div>
        <div className="nav-item" onClick={() => openPanel('automations')}><IconAutomations /><span>Automations</span></div>
        <h3>Recent</h3>
        {threads.slice(0, 8).map((t) => (
          <div key={t.id} className={`nav-item${thread === t.id ? ' active' : ''}`} onClick={() => switchThread(t.id)}>
            <IconProject />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.preview?.trim() || t.name || t.id.slice(0, 8)}</span>
          </div>
        ))}
        {threads.length === 0 && <div className="nav-item" onClick={() => openPanel('history')} style={{ color: '#a1a1aa' }}><IconProject /><span>No chats yet</span></div>}
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
              if (b.type === 'agent') return <div key={b.id} className="bubble assistant"><Markdown text={b.text} /></div>
              const dur = (b.endedAt ?? Date.now()) - b.startedAt
              const running = !b.endedAt
              const meaningful = b.activities.filter((a) => !(a.kind === 'reasoning' && a.id.startsWith('thinking-') && !a.detail))
              const stepsLabel = meaningful.length === 0
                ? (b.activities.some((a) => a.kind === 'reasoning' && a.detail) ? 'Thought through it' : 'Generated answer')
                : `${meaningful.length} step${meaningful.length === 1 ? '' : 's'}`
              return (
                <div key={b.id} className={`activity-card${b.collapsed ? ' collapsed' : ''}${running ? ' running' : ''}`}>
                  <div className="activity-head" onClick={() => toggleTurn(b.turnId)}>
                    <div className="head-left">
                      <span className={`spinner${running ? ' spin' : ''}`} />
                      <span className="head-title">{running ? 'Working…' : `Worked for ${fmtDuration(dur)}`}</span>
                      {!running && <span className="head-meta">· {stepsLabel}</span>}
                    </div>
                    <button className="chev" aria-label="Toggle"><IconChevron /></button>
                  </div>
                  {!b.collapsed && (
                    <div className="activity-body">
                      {b.activities.length === 0 ? (
                        <div className="empty-act">Preparing…</div>
                      ) : b.activities.map((a) => {
                        const isPlaceholder = a.kind === 'reasoning' && a.id.startsWith('thinking-') && !a.detail && a.status === 'running'
                        return (
                          <div key={a.id} className={`act act-${a.kind} act-${a.status}`}>
                            <div className="act-icon">{actIcon(a.kind)}</div>
                            <div className="act-meat">
                              <div className="act-title">{a.title}{isPlaceholder ? ' · waiting for first token' : ''}</div>
                              {a.detail && a.kind === 'reasoning' && (
                                <div className="act-detail">{a.detail}</div>
                              )}
                              {a.detail && a.kind === 'command' && (
                                <pre className="act-detail mono">{a.detail.slice(-1200)}</pre>
                              )}
                            </div>
                            <div className="act-status">
                              {a.status === 'running' ? '· · ·' :
                               a.status === 'failed' ? 'failed' :
                               a.endedAt ? fmtDuration(a.endedAt - a.startedAt) : ''}
                            </div>
                          </div>
                        )
                      })}
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

      {panel === 'search' && (
        <Drawer title="Search threads" onClose={() => setPanel(null)}>
          <input className="drawer-search" placeholder="Filter by preview…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          <div className="drawer-list">
            {threads.filter((t) => !searchQuery || (t.preview ?? '').toLowerCase().includes(searchQuery.toLowerCase())).map((t) => (
              <div key={t.id} className="drawer-row" onClick={() => switchThread(t.id)}>
                <div className="drawer-row-t">{t.preview?.trim() || t.name || '(no preview)'}</div>
                <div className="drawer-row-d">{t.id.slice(0, 8)} · {t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString() : ''}</div>
              </div>
            ))}
            {threads.length === 0 && <div className="drawer-empty">No threads yet. Start a new chat to get going.</div>}
          </div>
        </Drawer>
      )}

      {panel === 'skills' && (
        <Drawer title="Skills" onClose={() => setPanel(null)}>
          <p className="modal-hint">Skills are reusable capabilities (Office docs, search, etc.) declared by codex skills marketplace.</p>
          <div className="drawer-list">
            {skills.map((s, i) => (
              <div key={s.name + i} className="drawer-row">
                <div className="drawer-row-t">{s.name}</div>
                <div className="drawer-row-d">{s.description ?? ''}</div>
              </div>
            ))}
            {skills.length === 0 && <div className="drawer-empty">No skills installed in this workspace.</div>}
          </div>
        </Drawer>
      )}

      {panel === 'plugins' && (
        <Drawer title="Plugins" onClose={() => setPanel(null)}>
          <p className="modal-hint">Plugins extend zspark with marketplace skills, hooks, and tools. Install via codex CLI: <code>codex plugin install &lt;id&gt;</code>.</p>
          <div className="drawer-empty">Plugin marketplace UI coming soon. For now, manage via <code>codex plugin list</code>.</div>
        </Drawer>
      )}

      {panel === 'automations' && (
        <Drawer title="Automations" onClose={() => setPanel(null)}>
          <p className="modal-hint">Schedule recurring zspark tasks (daily standup digest, on-demand reports, Teams triggers).</p>
          <div className="drawer-empty">Coming in v0.2 — backed by zspark-server cron + Teams webhook.</div>
        </Drawer>
      )}

      {panel === 'history' && (
        <Drawer title="Chat history" onClose={() => setPanel(null)}>
          <div className="drawer-list">
            {threads.map((t) => (
              <div key={t.id} className="drawer-row" onClick={() => switchThread(t.id)}>
                <div className="drawer-row-t">{t.preview?.trim() || t.name || '(no preview)'}</div>
                <div className="drawer-row-d">{t.id.slice(0, 8)}</div>
              </div>
            ))}
            {threads.length === 0 && <div className="drawer-empty">No history.</div>}
          </div>
        </Drawer>
      )}

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
