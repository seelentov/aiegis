import { useEffect, useState } from 'react';

// A reveal not taken within this time is dropped: its entity is gone or its section was left.
const TTL_MS = 10_000;
let pending: { key: string; at: number } | null = null;
const subscribers = new Set<() => void>();

/** Asks whichever section shows `key` (`kind:id`) to bring it into view: its page, its filters, the scroll. */
export function reveal(key: string): void {
  pending = { key, at: Date.now() };
  for (const f of subscribers) f();
}

/** Calls `take` with a pending reveal on mount, on every reveal and whenever `deps` change; `take` returns true once it has shown the key. */
export function useReveal(take: (key: string) => boolean, deps: unknown[]): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    subscribers.add(f);
    return () => void subscribers.delete(f);
  }, []);
  useEffect(() => {
    if (pending && Date.now() - pending.at > TTL_MS) pending = null;
    if (pending && take(pending.key)) pending = null;
  }, [tick, ...deps]);
}
