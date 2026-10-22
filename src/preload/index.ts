import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNEL, IPC, type BridgeEvent, type StreamlyBridge } from '@shared/ipc'

const invoke = (channel: string, ...args: unknown[]): Promise<never> => ipcRenderer.invoke(channel, ...args) as Promise<never>

type Listener = (payload: unknown) => void
const listeners = new Map<BridgeEvent, Set<Listener>>()
ipcRenderer.on(EVENT_CHANNEL, (_e, event: BridgeEvent, payload: unknown) => {
  listeners.get(event)?.forEach((cb) => cb(payload))
})

const bridge: StreamlyBridge = {
  getSettings: () => invoke(IPC.getSettings),
  updateSettings: (patch) => invoke(IPC.updateSettings, patch),
  getRadmin: () => invoke(IPC.getRadmin),
  getAppInfo: () => invoke(IPC.getAppInfo),
  openExternal: (url) => invoke(IPC.openExternal, url),
  copyText: (text) => invoke(IPC.copyText, text),
  setTitleBar: (dark) => invoke(IPC.setTitleBar, dark),
  openLogs: () => invoke(IPC.openLogs),
  copyDiagnostics: () => invoke(IPC.copyDiagnostics),
  checkInvite: () => invoke(IPC.checkInvite),
  update: {
    getState: () => invoke(IPC.updateGetState),
    check: () => invoke(IPC.updateCheck),
    download: () => invoke(IPC.updateDownload),
    install: () => invoke(IPC.updateInstall),
    skip: (version) => invoke(IPC.updateSkip, version)
  },
  host: {
    getState: () => invoke(IPC.hostGetState),
    start: () => invoke(IPC.hostStart),
    install: () => invoke(IPC.hostInstall),
    submitCredentials: (u, p) => invoke(IPC.hostCredentials, u, p),
    stop: () => invoke(IPC.hostStop),
    respond: (id, d) => invoke(IPC.hostRespond, id, d),
    setPerms: (id, p) => invoke(IPC.hostSetPerms, id, p),
    kick: (id) => invoke(IPC.hostKick, id),
    kickAll: () => invoke(IPC.hostKickAll),
    installGamepad: () => invoke(IPC.hostInstallGamepad),
    selfCheck: () => invoke(IPC.hostSelfCheck),
    listTrusted: () => invoke(IPC.hostListTrusted),
    removeTrusted: (id) => invoke(IPC.hostRemoveTrusted, id),
    listDisplays: () => invoke(IPC.hostListDisplays),
    createInvite: () => invoke(IPC.hostCreateInvite),
    respondInput: (id, grant) => invoke(IPC.hostRespondInput, id, grant),
    setInputPaused: (paused) => invoke(IPC.hostSetInputPaused, paused),
    resetGamepad: (id) => invoke(IPC.hostResetGamepad, id)
  },
  client: {
    getState: () => invoke(IPC.clientGetState),
    discover: () => invoke(IPC.clientDiscover),
    getHosts: () => invoke(IPC.clientGetHosts),
    connect: (address, inviteCode) => invoke(IPC.clientConnect, address, inviteCode),
    diagnose: (address) => invoke(IPC.clientDiagnose, address),
    cancel: () => invoke(IPC.clientCancel),
    reset: () => invoke(IPC.clientReset),
    setSelfOff: (patch) => invoke(IPC.clientSetSelfOff, patch),
    restartStream: () => invoke(IPC.clientRestartStream),
    requestInput: (perms) => invoke(IPC.clientRequestInput, perms),
    resetGamepad: () => invoke(IPC.clientResetGamepad)
  },
  overlay: {
    close: () => invoke(IPC.overlayClose),
    toOtherScreen: () => invoke(IPC.overlayOtherScreen),
    toggleStats: () => invoke(IPC.overlayToggleStats)
  },
  on: (event, cb) => {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    const l = cb as Listener
    set.add(l)
    return () => set.delete(l)
  }
}

contextBridge.exposeInMainWorld('streamly', bridge)
