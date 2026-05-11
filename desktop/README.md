# zspark desktop

Electron + electron-vite + React + TS shell. Spawns codex-rs `codex` binary as child process and talks app-server JSON-RPC over stdio.

Build:
```
pnpm i
pnpm dev          # local dev
pnpm build:win    # NSIS installer
pnpm build:mac    # dmg
```
