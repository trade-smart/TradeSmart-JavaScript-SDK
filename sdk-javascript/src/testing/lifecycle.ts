// Who keeps an offline broker alive, and how one that was never closed is cleaned up (Python:
// testing/_broker.py `_OWNERS`, `weakref.finalize`).
//
// Every client and stream a broker builds is a weak key whose value is the broker, so a helper
// that returns only the client still has a running stream server and its private folder. When the
// broker and everything built from it are collected, a `FinalizationRegistry` callback stops the
// server (it would otherwise keep listening for as long as the process lives) and deletes the
// folder. The held value never refers to the broker, or it would never be collected.
import { rmSync } from "node:fs";
import type { OfflineBroker } from "./broker.js";
import type { OfflineStreamServer } from "./ws.js";

/** What a broker leaves behind: its private script-master folder and its stream server. */
export interface Orphan {
  readonly dir: string;
  server: OfflineStreamServer | null;
}

const OWNERS = new WeakMap<object, OfflineBroker>();

/** Make `built` (a client or stream) keep `broker` alive; returns `built`. */
export function own<T extends object>(built: T, broker: OfflineBroker): T {
  OWNERS.set(built, broker);
  return built;
}

/** The broker that built `built`, or `undefined`. */
export function ownerOf(built: object): OfflineBroker | undefined {
  return OWNERS.get(built);
}

/**
 * Stop the server and delete the folder of a broker that was never closed. Safe to repeat; a
 * folder that cannot be removed stays (it holds only synthetic data).
 */
export function releaseOrphan(orphan: Orphan): void {
  try {
    orphan.server?.abort();
  } catch {
    // nothing more to do for a server that is already gone
  }
  try {
    rmSync(orphan.dir, { recursive: true, force: true });
  } catch {
    // see above
  }
}

const REGISTRY = new FinalizationRegistry<Orphan>(releaseOrphan);

/** Clean `orphan` up when `broker` is collected; `forget` with the same broker undoes it. */
export function watch(broker: OfflineBroker, orphan: Orphan): void {
  REGISTRY.register(broker, orphan, broker);
}

/** `close()` did the cleanup: the finalizer has nothing left to do. */
export function forget(broker: OfflineBroker): void {
  REGISTRY.unregister(broker);
}
