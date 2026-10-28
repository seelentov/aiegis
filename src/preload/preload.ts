import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNEL, invokeChannel, type ApiMethod, type Bridge } from '../shared/api';
import type { AppEvent } from '../shared/types';

const bridge: Bridge = {
  invoke: (method: ApiMethod, ...args: unknown[]) => ipcRenderer.invoke(invokeChannel(method), ...args),
  onEvent: (cb: (ev: AppEvent) => void) => {
    const listener = (_: unknown, ev: AppEvent) => cb(ev);
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('aiegis', bridge);
