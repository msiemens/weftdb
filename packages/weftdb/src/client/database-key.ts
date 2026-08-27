// Which database a tab means, as one string.
//
// A device's database is a namespace and a scope together, never either alone. The scope says whose
// rows these are; the namespace says which application in this origin is keeping them, which is why
// it already decides where the device id is stored. The client the storage worker holds is keyed on
// the pair through here, so two `openWeftDatabase` calls that differ in either are two databases and
// nothing they do reaches each other.
//
// Both halves are strings an application chose, and that is the whole difficulty of composing them.
// Joined with a separator alone, namespace `a:b` with scope `c` and namespace `a` with scope `b:c`
// produce one key, so two applications would share one lock, one worker and one file, with nothing
// anywhere reporting it. The length prefix removes the ambiguity, because the digits before the
// first colon say how long the namespace is, so where it ends is read off the key instead of
// searched for, and both halves may then hold any character at all, colons included.

/** What a database with no namespace of its own is in. Also what prefixes the device id's key. */
export const DEFAULT_NAMESPACE = "weft";

/**
 * One database, as the pair that names it.
 *
 * Application code reading this decides something per database: an endpoint under the namespace, a
 * credential for the scope, a port one tab transferred in. Each of those wants a half.
 */
export interface WeftDatabaseIdentity {
  readonly namespace: string;
  readonly scopeId: string;
}

/**
 * The key for one device database: `<length>:<namespace>:<scopeId>`.
 *
 * Distinct pairs give distinct keys, which is the only property anything asks of it. Reading it back
 * is unambiguous too, because the leading digits end at the first colon and say how many characters
 * of namespace follow, and the scope is the remainder.
 */
export function weftDatabaseKey(scopeId: string, namespace: string = DEFAULT_NAMESPACE): string {
  return `${String(namespace.length)}:${namespace}:${scopeId}`;
}
