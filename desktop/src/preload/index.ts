import { contextBridge, ipcRenderer } from 'electron'

const api = {
  send: (line: string) => ipcRenderer.invoke('codex:send', line),
  restart: () => ipcRenderer.invoke('codex:restart'),
  pickAttachments: () => ipcRenderer.invoke('attachments:pick'),
  getRuntimeInfo: () => ipcRenderer.invoke('runtime:get'),
  discoverLocalSkills: () => ipcRenderer.invoke('skills:localAvailability'),
  openPath: (path: string) => ipcRenderer.invoke('path:open', path),
  revealPath: (path: string) => ipcRenderer.invoke('path:reveal', path),
  downloadPath: (path: string) => ipcRenderer.invoke('path:download', path),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: any) => ipcRenderer.invoke('settings:save', s),
  onStdout: (cb: (s: string) => void) => ipcRenderer.on('codex:stdout', (_e, s) => cb(s)),
  onStderr: (cb: (s: string) => void) => ipcRenderer.on('codex:stderr', (_e, s) => cb(s)),
  onExit: (cb: (code: number | null) => void) => ipcRenderer.on('codex:exit', (_e, c) => cb(c)),
  onSpawned: (cb: () => void) => ipcRenderer.on('codex:spawned', () => cb())
}

contextBridge.exposeInMainWorld('zspark', api)
export type ZsparkApi = typeof api
