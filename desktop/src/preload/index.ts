import { contextBridge, ipcRenderer } from 'electron'

const api = {
  send: (line: string) => ipcRenderer.invoke('codex:send', line),
  restart: () => ipcRenderer.invoke('codex:restart'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: any) => ipcRenderer.invoke('settings:save', s),
  onStdout: (cb: (s: string) => void) => ipcRenderer.on('codex:stdout', (_e, s) => cb(s)),
  onStderr: (cb: (s: string) => void) => ipcRenderer.on('codex:stderr', (_e, s) => cb(s)),
  onExit: (cb: (code: number | null) => void) => ipcRenderer.on('codex:exit', (_e, c) => cb(c))
}

contextBridge.exposeInMainWorld('zspark', api)
export type ZsparkApi = typeof api
