import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CODE_INSPECTOR_CHANNELS, type CodeInspectorChildApi, type CodeInspectorPacket } from '../shared/code-inspector';

const api: CodeInspectorChildApi = {
  onPacket(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event: IpcRendererEvent, packet: CodeInspectorPacket) => callback(packet);
    ipcRenderer.on(CODE_INSPECTOR_CHANNELS.packet, listener);
    return () => {
      ipcRenderer.removeListener(CODE_INSPECTOR_CHANNELS.packet, listener);
    };
  },
  ready: () => ipcRenderer.send(CODE_INSPECTOR_CHANNELS.ready),
  action: (action) => ipcRenderer.send(CODE_INSPECTOR_CHANNELS.action, action),
  setDirty: (dirty) => ipcRenderer.send(CODE_INSPECTOR_CHANNELS.dirty, dirty),
};

contextBridge.exposeInMainWorld('allayCodeInspector', api);
