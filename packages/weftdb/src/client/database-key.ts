// Which database a tab means, as one string.
//
// A device's database is a namespace and a scope together, never either alone. The scope says whose
// rows these are; the namespace says which application in this origin is keeping them, which is why
// it already decides where the device id is stored. Everything else that has to agree between tabs —
// the Web Lock the election runs on, the key the port broker registers a provider under — is keyed
// on the pair through here, so two `openWeftDatabase` calls that differ in either are two databases
// and nothing they do reaches each other.
//
// Both halves are strings an application chose, and that is the whole difficulty of composing them.
// Joined with a separator alone, namespace `a:b` with scope `c` and namespace `a` with scope `b:c`
// produce one key — two applications sharing one lock, one worker and one file, with nothing
// anywhere reporting it. The length prefix removes the ambiguity rather than forbidding a character:
// the digits before the first colon say how long the namespace is, so where it ends is read off the
// key instead of searched for, and both halves may then hold any character at all, colons included.

/** What a database with no namespace of its own is in. Also what prefixes the device id's key. */
export const DEFAULT_NAMESPACE = "weft";

/**
 * The search parameter the page writes its namespace into when it constructs the storage worker,
 * and the one the worker reads back to decide which OPFS pool is its own.
 *
 * The worker is where the database is opened and the page is where the namespace is known, so one
 * of the two has to travel. It travels on the worker's URL because that is the only channel that
 * exists before the worker runs: a message would arrive after the module had already opened a file,
 * and a second application's tab would have been refused the pool by then. Declared here, beside
 * the key, so the two ends cannot be spelled differently.
 */
export const WEFT_NAMESPACE_PARAM = "weft-namespace";

/**
 * The key for one device database: `<length>:<namespace>:<scopeId>`.
 *
 * Distinct pairs give distinct keys, which is the only property anything asks of it. Reading it back
 * is unambiguous for the same reason: the leading digits end at the first colon and say how many
 * characters of namespace follow, and the scope is the remainder.
 */
export function weftDatabaseKey(scopeId: string, namespace: string = DEFAULT_NAMESPACE): string {
  return `${String(namespace.length)}:${namespace}:${scopeId}`;
}
