import { deviceId, isWeftOp, scopeId, type DeviceId, type ScopeId, type SchemaHash, type WeftOp } from "weftdb/core";
import { contentAddressSnapshot, type SnapshotEnvelope } from "./snapshot.ts";
import type { HandshakeRequest, HandshakeResponse, PullBatch, PushOutcome, WeftServer } from "./index.ts";

export interface AuthContext {
  readonly scopeId: ScopeId;
  readonly deviceId: DeviceId;
}

export interface TokenVerifier {
  verify(token: string): AuthContext | undefined | Promise<AuthContext | undefined>;
}

export interface RelayOptions {
  readonly server: WeftServer;
  readonly verifier: TokenVerifier;
}

/** What a device asks for during a session, named alike whichever surface carries it. */
export interface SyncArguments {
  readonly handshake: {
    readonly schemaHash: SchemaHash;
    readonly schemaVersion: number;
    readonly lastServerSeq: number;
  };
  readonly push: { readonly ops: readonly WeftOp[] };
  readonly pull: { readonly lastServerSeq: number };
  readonly snapshot: Record<string, never>;
}

export interface SyncResults {
  readonly handshake: HandshakeResponse;
  readonly push: PushOutcome;
  readonly pull: PullBatch;
  readonly snapshot: SnapshotEnvelope;
}

export type SyncOperation = keyof SyncArguments;

/**
 * The protocol itself, with no surface attached. HTTP and the socket both reach these calls and
 * neither implements them, so there is one place a request is carried out and one place (the
 * `AuthContext` its caller had to obtain) where the scope is decided.
 */
export type SyncOperations = {
  readonly [Op in SyncOperation]: (auth: AuthContext, argument: SyncArguments[Op]) => SyncResults[Op];
};

export function syncOperations(options: RelayOptions): SyncOperations {
  return {
    handshake: (auth, argument) =>
      options.server.handshake({
        scopeId: auth.scopeId,
        deviceId: auth.deviceId,
        schemaHash: argument.schemaHash,
        schemaVersion: argument.schemaVersion,
        lastServerSeq: argument.lastServerSeq,
      }),
    push: (auth, argument) => options.server.push(auth.scopeId, [...argument.ops]),
    pull: (auth, argument) => options.server.pull(auth.scopeId, argument.lastServerSeq),
    snapshot: (auth) => {
      // Only the envelope goes here. The records are in the body, and sending them structured
      // as well would double the largest response this relay produces.
      const { snapshot: _snapshot, ...envelope } = contentAddressSnapshot(options.server.snapshot(auth.scopeId));
      return envelope;
    },
  };
}

export function createRelayHandler(options: RelayOptions): (request: Request) => Promise<Response> {
  // The HTTP surface turns a route and a body into one of the calls, and nothing else.
  const operations = syncOperations(options);
  return async (request) => {
    const auth = await authenticate(request, options.verifier);
    if (auth === undefined) return json({ error: "unauthorized" }, 401);

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/handshake") {
      const body = (await request.json()) as Partial<HandshakeRequest>;
      if (body.scopeId !== auth.scopeId) return json({ error: "scope_mismatch" }, 403);
      // Every field is checked before the call, so a malformed handshake never reaches the point
      // where it would register the device and take the scope's schema metadata from it.
      return json(
        operations.handshake(auth, {
          schemaHash: requiredHash(body.schemaHash),
          schemaVersion: requiredCount(body.schemaVersion, "schemaVersion", 1),
          lastServerSeq: requiredCount(body.lastServerSeq, "lastServerSeq", 0),
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/push") {
      const body = (await request.json()) as { readonly ops?: unknown };
      return json(operations.push(auth, { ops: requiredOps(body.ops) }));
    }

    if (request.method === "GET" && url.pathname === "/pull") {
      return json(operations.pull(auth, { lastServerSeq: requiredCursor(url.searchParams.get("last_server_seq")) }));
    }

    if (request.method === "GET" && url.pathname === "/snapshot") {
      return json(operations.snapshot(auth, {}));
    }

    return json({ error: "not_found" }, 404);
  };
}

export function staticTokenVerifier(tokens: ReadonlyMap<string, AuthContext>): TokenVerifier {
  return { verify: (token) => tokens.get(token) };
}

export function authContext(scope: string, device: string): AuthContext {
  return { scopeId: scopeId(scope), deviceId: deviceId(device) };
}

async function authenticate(request: Request, verifier: TokenVerifier): Promise<AuthContext | undefined> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  if (token === undefined) return undefined;
  return verifier.verify(token);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A sequence number that counts records. `NaN` and both infinities pass every comparison a
 * cursor is used in, so one accepted here is a client that silently receives nothing for the
 * rest of its life.
 */
export function requiredCount(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

export function requiredCursor(value: string | null): number {
  return requiredCount(value === null || value.length === 0 ? 0 : Number(value), "last_server_seq", 0);
}

export function requiredOps(value: unknown): readonly WeftOp[] {
  if (!Array.isArray(value)) throw new Error("ops must be an array");
  for (const op of value) {
    if (!isWeftOp(op)) throw new Error(`ops contains something that is not an operation: ${JSON.stringify(op)}`);
  }
  return value as readonly WeftOp[];
}

function requiredHash(value: unknown): SchemaHash {
  if (typeof value !== "string" || value.length === 0) throw new Error("schemaHash must be a non-empty string");
  return value as SchemaHash;
}
