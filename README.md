# zspark

Internal codex-app alternative for daily office work. Built on top of OpenAI's open-source [codex](https://github.com/openai/codex) engine.

## Goals
- **Self-hosted, controllable**: runs entirely inside corporate boundary
- **Windows Domain SSO** (Kerberos/NTLM) on day 1
- **Microsoft Teams** integration (notify, share, receive prompts)
- **Skills** based productivity (PPT, Excel, Word via codex skills)
- **Multi-user collaboration** via self-hosted server (Yjs CRDT over WebSocket)
- **Sandboxed agent**: macOS seatbelt + Windows AppContainer (we do NOT ship Linux client)

## Layout
- `codex-rs/` — forked codex engine (Linux sandbox kept but unsupported in zspark distro)
- `desktop/` — Electron shell (Win + macOS installers)
- `server/` — collaboration / SSO / Teams hub (Node + Yjs + Postgres)

## Status
v0 — bootstrapping.
