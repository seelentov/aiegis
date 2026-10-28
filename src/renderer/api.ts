import type { ApiMethod, AsyncApi, Bridge } from '../shared/api';

declare global {
  interface Window {
    aiegis: Bridge;
  }
}

export const bridge: Bridge = window.aiegis;

/** Typed async proxy over the IPC bridge. */
export const api = new Proxy({} as AsyncApi, {
  get: (_t, method: string) => (...args: unknown[]) => bridge.invoke(method as ApiMethod, ...args),
});

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Electron prefixes errors thrown in handlers.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
