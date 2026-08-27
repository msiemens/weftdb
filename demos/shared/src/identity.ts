// Who a tab is, and whose data it is looking at.
//
// Two levels, with different lifetimes:
//
//   scope   one per visitor, in local storage. Shared by every tab of that browser and kept
//           across reloads, so a second tab reads the same visitor's data. A deployed demo has
//           many visitors on one relay; each is a scope.
//   device  one per tab, in session storage. Reloading keeps your unsent work, and a new tab is
//           a new device, each with its own outbox, clock and cursor, merging through the relay
//           exactly as a laptop and a phone would.
//
// Scope equality is the whole of the authorization model, so this is also what keeps one visitor
// out of another's rows, and the todo demo out of the chat demo.
import { deviceId, scopeId, type DeviceId, type ScopeId } from "weftdb/core";
import type { StorageLike } from "weftdb/client";
import { demoToken } from "./auth.ts";

/** Namespaces every key these demos write, so nothing collides with the host page. */
const NAMESPACE = "weftdb-demo";

/**
 * What every key a demo writes begins with. `reset.ts` clears a demo by this prefix and names its
 * databases from it, so a key written outside it survives a reset the visitor asked for.
 */
export function demoKeyPrefix(demo: string): string {
  return `${NAMESPACE}/${demo}/`;
}

export interface TabIdentity {
  readonly scopeId: ScopeId;
  readonly deviceId: DeviceId;
  /** What the tab calls itself in the UI, e.g. `tab 2`. */
  readonly label: string;
  /**
   * The relay's bearer token. A real deployment issues these after sign-in; the demo relay
   * accepts `demo.<scope>.<device>` from anyone, which is why it binds to loopback.
   */
  readonly token: string;
}

export interface TabIdentityOptions {
  /** Slug of the demo. Namespaces its storage and prefixes the visitor's scope id. */
  readonly demo: string;
  /**
   * Pins the scope instead of deriving one per visitor, for tests, and for a local run where a
   * predictable scope is easier to inspect in the relay's SQLite file.
   */
  readonly scope?: ScopeId | undefined;
}

export async function tabIdentity(
  session: StorageLike,
  local: StorageLike,
  options: TabIdentityOptions,
): Promise<TabIdentity> {
  const scope = options.scope ?? (await visitorScope(local, options.demo));
  const deviceKey = `${demoKeyPrefix(options.demo)}device`;
  const counterKey = `${demoKeyPrefix(options.demo)}tab-counter`;

  const existing = session.getItem(deviceKey);
  if (existing !== null) {
    const parsed = JSON.parse(existing) as { readonly id: string; readonly label: string };
    return identityFor(scope, parsed.id, parsed.label);
  }
  // Two tabs opened at once read the same counter and both claim the next number, since local
  // storage has no atomic increment, so the ordinal is a convenience and the suffix is what
  // actually tells them apart. Both go in the label, because a device you cannot name is one you
  // cannot reason about when its edits show up somewhere unexpected.
  const ordinal = Number(local.getItem(counterKey) ?? "0") + 1;
  local.setItem(counterKey, String(ordinal));
  const suffix = randomToken(1);
  const id = `tab-${ordinal}-${suffix}`;
  const label = `tab ${ordinal} · ${suffix}`;
  session.setItem(deviceKey, JSON.stringify({ id, label }));
  return identityFor(scope, id, label);
}

/**
 * The visitor's own scope, made once and kept.
 *
 * It is long because it is the only thing separating one visitor's rows from another's. The relay
 * accepts whatever scope a token names, so a guessable id would be a readable one, and being hard
 * to guess is only obscurity, as the note in `auth.ts` explains. A demo relay belongs on loopback
 * or behind something that knows who is asking.
 */
async function visitorScope(local: StorageLike, demo: string): Promise<ScopeId> {
  const key = `${demoKeyPrefix(demo)}scope`;
  const settled = local.getItem(key);
  if (settled !== null && settled !== "") return scopeId(settled);
  // Held across the read and the write, since local storage has no compare-and-set, so two tabs
  // opened together both find nothing and both mint, and the one whose write lands second leaves
  // the other running under a scope no storage names. Two tabs of one visitor are then in
  // separate worlds for as long as they stay open, because scope equality is the whole of what
  // decides which rows a tab can see.
  return await withTabLock(key, async () => {
    const won = local.getItem(key);
    if (won !== null && won !== "") return scopeId(won);
    const id = `${demo}-${randomToken(4)}`;
    local.setItem(key, id);
    return scopeId(id);
  });
}

/**
 * Runs `body` alone across this origin, where the browser has Web Locks. Node has them from 26, so
 * a test drives the same path a tab does.
 */
export async function withTabLock<T>(name: string, body: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (locks === undefined) return await body();
  return await locks.request(name, body);
}

interface LockManagerLike {
  request<T>(name: string, body: () => Promise<T>): Promise<T>;
}

function identityFor(scope: ScopeId, id: string, label: string): TabIdentity {
  return { scopeId: scope, deviceId: deviceId(id), label, token: demoToken(scope, id) };
}

/** `words` × 32 bits of randomness, base36. Distinct across profiles and private windows. */
function randomToken(words: number): string {
  const values = crypto.getRandomValues(new Uint32Array(words));
  return [...values]
    .map((value) => value.toString(36).padStart(7, "0"))
    .join("")
    .slice(0, words * 4);
}
