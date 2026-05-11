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

export function App() {
  const [stream, setStream] = useState('')
  const [input, setInput] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.zspark.onStdout((s) => setStream((prev) => prev + s))
    window.zspark.onStderr((s) => setStream((prev) => prev + `[stderr] ${s}`))
    window.zspark.onExit((c) => setStream((prev) => prev + `\n[codex exited: ${c}]\n`))
  }, [])

  useEffect(() => {
    streamRef.current?.scrollTo(0, streamRef.current.scrollHeight)
  }, [stream])

  const submit = async () => {
    if (!input.trim()) return
    setStream((p) => p + `\n> ${input}\n`)
    await window.zspark.send(JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'user_input', params: { text: input } }))
    setInput('')
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
        <div className="chat-stream" ref={streamRef}>{stream || 'Connect to a workspace to begin...'}</div>
        <div className="chat-input">
          <input
            placeholder="Ask zspark anything. @ to use plugins or mention files"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button onClick={submit}>Send</button>
        </div>
      </main>
      <aside className="right">
        <h4>Workspace</h4>
        <div>Sandbox: AppContainer (Win) / Seatbelt (mac)</div>
        <div>Auth: Windows Domain SSO</div>
        <div>Collab: zspark-server (offline)</div>
      </aside>
    </div>
  )
}
