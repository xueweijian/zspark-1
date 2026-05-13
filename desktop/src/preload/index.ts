import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const api = {
  send: (line: string) => ipcRenderer.invoke('codex:send', line),
  restart: () => ipcRenderer.invoke('codex:restart'),
  pickAttachments: () => ipcRenderer.invoke('attachments:pick'),
  getRuntimeInfo: () => ipcRenderer.invoke('runtime:get'),
  discoverLocalSkills: () => ipcRenderer.invoke('skills:localAvailability'),
  openSkillPath: (path: string) => ipcRenderer.invoke('skill:open', path),
  openPath: (path: string) => ipcRenderer.invoke('path:open', path),
  revealPath: (path: string) => ipcRenderer.invoke('path:reveal', path),
  downloadPath: (path: string) => ipcRenderer.invoke('path:download', path),
  statPath: (path: string) => ipcRenderer.invoke('path:stat', path),
  openExternalUrl: (url: string) => ipcRenderer.invoke('url:openExternal', url),
  scanRecentArtifacts: (options?: { sinceMs?: number; limit?: number }) => ipcRenderer.invoke('artifacts:scanRecent', options),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: any) => ipcRenderer.invoke('settings:save', s),
  enterpriseStatus: () => ipcRenderer.invoke('enterprise:status'),
  enterpriseLogin: () => ipcRenderer.invoke('enterprise:login'),
  enterpriseLogout: () => ipcRenderer.invoke('enterprise:logout'),
  enterpriseWhoami: () => ipcRenderer.invoke('enterprise:whoami'),
  enterpriseWorkspaces: () => ipcRenderer.invoke('enterprise:workspaces'),
  enterpriseCreateWorkspace: (name?: string) => ipcRenderer.invoke('enterprise:createWorkspace', name),
  enterpriseSessions: (workspaceId: string) => ipcRenderer.invoke('enterprise:sessions', workspaceId),
  enterpriseCreateSession: (workspaceId: string, body?: any) => ipcRenderer.invoke('enterprise:createSession', workspaceId, body),
  enterpriseReadSession: (workspaceId: string, sessionId: string) => ipcRenderer.invoke('enterprise:readSession', workspaceId, sessionId),
  enterpriseUpdateSession: (workspaceId: string, sessionId: string, body?: any) => ipcRenderer.invoke('enterprise:updateSession', workspaceId, sessionId, body),
  enterpriseDeleteSession: (workspaceId: string, sessionId: string) => ipcRenderer.invoke('enterprise:deleteSession', workspaceId, sessionId),
  enterpriseArtifacts: (workspaceId: string, sessionId: string) => ipcRenderer.invoke('enterprise:artifacts', workspaceId, sessionId),
  enterpriseUploadArtifact: (workspaceId: string, sessionId: string, filePath: string, meta?: any) => ipcRenderer.invoke('enterprise:uploadArtifact', workspaceId, sessionId, filePath, meta),
  enterpriseDownloadArtifact: (workspaceId: string, sessionId: string, artifactId: string, name?: string) => ipcRenderer.invoke('enterprise:downloadArtifact', workspaceId, sessionId, artifactId, name),
  onEnterpriseDeviceCode: (cb: (payload: { userCode?: string; verificationUri?: string; message?: string; expiresOn?: number | null }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { userCode?: string; verificationUri?: string; message?: string; expiresOn?: number | null }) => cb(payload)
    ipcRenderer.on('enterprise:deviceCode', listener)
    return () => ipcRenderer.removeListener('enterprise:deviceCode', listener)
  },
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
