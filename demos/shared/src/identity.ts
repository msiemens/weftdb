// Who a tab is, and whose data it is looking at.
//
// Two levels, and they are deliberately different lifetimes:
//
//   scope   one per visitor, in local storage. Shared by every tab of that browser and kept
//           across reloads, so opening a second tab shows you your own data rather than a
//           stranger's. A deployed demo has many visitors on one relay; each is a scope.
//   device  one per tab, in session storage. Reloading keeps your unsent work, a new tab is a
//           new device. That is what makes opening a second tab interesting: two devices holding
//           the same data, each with its own outbox, clock and cursor, merging through the relay
//           exactly as a laptop and a phone would.
//
// Scope equality is the whole of the authorization model, so this is also what keeps one visitor
// out of another's rows, and the todo demo out of the chat demo.
import { deviceId, scopeId, type DeviceId, type ScopeId } from "weftdb/shared";
import type { StorageLike } from "weftdb/client";
import { demoToken } from "./auth.ts";

/** Namespaces every key these demos write, so nothing collides with the host page. */
const NAMESPACE = "weftdb-demo";

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
   * Pins the scope instead of deriving one per visitor. For tests, and for a local run where a
   * predictable scope is easier to inspect in the relay's SQLite file.
   */
  readonly scope?: ScopeId | undefined;
}

export function tabIdentity(session: StorageLike, local: StorageLike, options: TabIdentityOptions): TabIdentity {
  const scope = options.scope ?? visitorScope(local, options.demo);
  const deviceKey = `${NAMESPACE}/${options.demo}/device`;
  const counterKey = `${NAMESPACE}/${options.demo}/tab-counter`;

  const existing = session.getItem(deviceKey);
  if (existing !== null) {
    const parsed = JSON.parse(existing) as { readonly id: string; readonly label: string };
    return identityFor(scope, parsed.id, parsed.label);
  }
  // Two tabs opened at once read the same counter and both claim the next number — local storage
  // has no atomic increment — so the ordinal is a convenience and the suffix is what actually
  // tells them apart. Both go in the label: a device you cannot name is one you cannot reason
  // about when its edits show up somewhere unexpected.
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
 * It is long because it is the only thing separating one visitor's rows from another's: the relay
 * accepts whatever scope a token names, so a guessable id would be a readable one. That makes it
 * unguessable, which is not the same as access control — see the note in `auth.ts`. A demo relay
 * belongs on loopback or behind something that knows who is asking.
 */
function visitorScope(local: StorageLike, demo: string): ScopeId {
  const key = `${NAMESPACE}/${demo}/scope`;
  const existing = local.getItem(key);
  if (existing !== null && existing !== "") return scopeId(existing);
  const id = `${demo}-${randomToken(4)}`;
  local.setItem(key, id);
  return scopeId(id);
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
