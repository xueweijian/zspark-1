import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const api = {
  send: (line: string) => ipcRenderer.invoke('codex:send', line),
  restart: () => ipcRenderer.invoke('codex:restart'),
  pickAttachments: () => ipcRenderer.invoke('attachments:pick'),
  getRuntimeInfo: () => ipcRenderer.invoke('runtime:get'),
  discoverLocalSkills: () => ipcRenderer.invoke('skills:localAvailability'),
  openPath: (path: string) => ipcRenderer.invoke('path:open', path),
  revealPath: (path: string) => ipcRenderer.invoke('path:reveal', path),
  downloadPath: (path: string) => ipcRenderer.invoke('path:download', path),
  statPath: (path: string) => ipcRenderer.invoke('path:stat', path),
  scanRecentArtifacts: (options?: { sinceMs?: number; limit?: number }) => ipcRenderer.invoke('artifacts:scanRecent', options),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: any) => ipcRenderer.invoke('settings:save', s),
  onStdout: (cb: (s: string) => void) => {
    const listener = (_e: IpcRendererEvent, s: string) => cb(s)
    ipcRenderer.on('codex:stdout', listener)
    return () => ipcRenderer.removeListener('codex:stdout', listener)
  },
  onStderr: (cb: (s: string) => void) => {
    const listener = (_e: IpcRendererEvent, s: string) => cb(s)
    ipcRenderer.on('codex:stderr', listener)
    return () => ipcRenderer.removeListener('codex:stderr', listener)
  },
  onExit: (cb: (code: number | null) => void) => {
    const listener = (_e: IpcRendererEvent, c: number | null) => cb(c)
    ipcRenderer.on('codex:exit', listener)
    return () => ipcRenderer.removeListener('codex:exit', listener)
  },
  onSpawned: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('codex:spawned', listener)
    return () => ipcRenderer.removeListener('codex:spawned', listener)
  }
}

contextBridge.exposeInMainWorld('zspark', api)
export type ZsparkApi = typeof api
