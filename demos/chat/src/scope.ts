// What this demo calls itself on the shared relay.
//
// `DEMO` prefixes the visitor's own scope id and namespaces the demo's storage keys, so two demos
// open in two tabs of one browser neither read each other's device record nor land in each other's
// rows. Each visitor gets a scope of their own underneath it; see `visitorScope` in
// `weftdb-demo-shared/identity`. One scope is one room.
import { scopeId, type ScopeId } from "weftdb/core";

export const DEMO = "chat";

/**
 * A fixed scope, for tests and for a local run where a predictable id is easier to find in the
 * relay's SQLite file. The page does not use it, since a visitor gets their own room.
 */
export const CHAT_SCOPE: ScopeId = scopeId("chat-fixed");
