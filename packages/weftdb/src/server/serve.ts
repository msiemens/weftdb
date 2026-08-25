// The runnable relay: a Node HTTP listener around the fetch-style handler in relay.ts, plus
// the configuration a deployment needs. This is what the container image runs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WeftServer } from "./index.ts";
import { SqliteWeftServer } from "./sqlite.ts";
import {
  authContext,
  createRelayHandler,
  staticTokenVerifier,
  syncOperations,
  type AuthContext,
  type TokenVerifier,
} from "./relay.ts";
import { SyncSocketHub } from "./websocket.ts";
import { claimsToContext, jwtVerifier, type JwtAlgorithm, type JwtVerifierOptions } from "./jwt.ts";

export interface ServeOptions {
  readonly host: string;
  readonly port: number;
  /** SQLite file to persist into. Omitted means an in-memory server that forgets on exit. */
  readonly databasePath?: string;
  readonly tokens: ReadonlyMap<string, AuthContext>;
  /**
   * Replaces the static token table. Deployments that issue tokens rather than list them —
   * and the demo, which lets any tab name itself — supply their own verifier here.
   */
  readonly verifier?: TokenVerifier;
  /** How often the sync socket pings. Zero turns the keepalive off. */
  readonly keepaliveMs?: number;
  /** How far ahead of the relay's clock a write may be stamped before it is refused. */
  readonly skewThresholdMs?: number;
  /** How often to prune tombstones across every scope. Zero turns the sweep off. */
  readonly pruneIntervalMs?: number;
  /** Passed to `pruneTombstones` on each scheduled sweep. Defaults to its own default, 30 days. */
  readonly pruneOlderThanMs?: number;
}

/** Where the sync socket lives, relative to the relay's origin. */
export const SYNC_SOCKET_PATH = "/sync";

/**
 * Daily. The threshold that decides what is old enough to purge is `pruneOlderThanMs`, so this
 * only sets how often the question is asked, and asking more often than the threshold changes
 * nothing except how promptly the floor advances.
 */
export const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RunningServer {
  readonly url: string;
  readonly server: WeftServer;
  /** The sync socket's connections, so a deployment can see who is attached. */
  readonly sockets: SyncSocketHub;
  close(): Promise<void>;
}

export async function startRelay(options: ServeOptions): Promise<RunningServer> {
  const { server, dispose } = await openServer(options);
  const verifier = options.verifier ?? staticTokenVerifier(options.tokens);
  const handler = createRelayHandler({ server, verifier });
  const sockets = new SyncSocketHub({
    verifier,
    // The socket carries whole sync sessions, through the same four calls HTTP reaches.
    operations: syncOperations({ server, verifier }),
    // What a subscribed connection is sent when its scope moves: the same batch the same
    // `/pull` would have answered with, delivered without being asked for it.
    pull: (scopeId, lastServerSeq) => server.pull(scopeId, lastServerSeq),
    ...(options.keepaliveMs === undefined ? {} : { keepaliveMs: options.keepaliveMs }),
  });
  // Watching the server rather than the HTTP surface means every path that moves a scope wakes
  // its devices, including the ones no client asked for — a prune raising the tombstone floor.
  // This relay is the only one there is; several sharing a database would need the advance to
  // travel between the processes, which is noted in TODO.md and not built.
  const unwatch = server.watch((scopeId, serverSeq) => sockets.advanced(scopeId, serverSeq));
  const pruneTimer = startPruneTimer(server, options);
  const http = createServer(createRequestListener(withHealthCheck(handler)));
  // One route, so nothing else on the origin can be upgraded by accident.
  http.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== SYNC_SOCKET_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void sockets.upgrade(request, socket, head);
  });

  // A port already in use arrives as an `error` event rather than a failed callback, so
  // without this it escapes as an unhandled event and takes the process down with a stack
  // trace instead of an answer.
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => {
      http.close();
      reject(error);
    };
    http.once("error", failed);
    http.listen(options.port, options.host, () => {
      http.removeListener("error", failed);
      resolve();
    });
  });
  return {
    url: addressOf(http, options.host),
    server,
    sockets,
    close: async () => {
      // Open sockets keep `close` from ever calling back, so they are dropped first.
      unwatch();
      if (pruneTimer !== undefined) clearInterval(pruneTimer);
      sockets.close();
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
      dispose();
    },
  };
}

/**
 * Sweeps every scope the server knows about, on an interval.
 *
 * Pruning runs by default because the protocol assumes it has: a scope's `tombstone_floor_seq`
 * only advances here, and a device below the floor is what makes a snapshot resync necessary. A
 * relay that never prunes keeps every tombstone it has ever written and leaves the floor at zero,
 * so the resync path never triggers and storage grows without bound. `pruneIntervalMs: 0` turns
 * the sweep off, the same way `keepaliveMs` does.
 *
 * `server.scopes` is already populated for every scope the server has handled: the in-memory
 * `WeftServer` fills it in as scopes are touched, and `SqliteWeftServer` reads every row of it
 * out of storage at construction. Nothing further is needed to find the scopes to prune.
 */
function startPruneTimer(server: WeftServer, options: ServeOptions): ReturnType<typeof setInterval> | undefined {
  const intervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  if (intervalMs <= 0) return undefined;
  const timer = setInterval(() => {
    for (const scopeId of [...server.scopes.keys()]) {
      try {
        server.pruneTombstones(scopeId, options.pruneOlderThanMs);
      } catch {
        // One scope's prune failing is not a reason to leave every other scope's tombstones
        // unpruned, or to skip this scope again next time.
      }
    }
  }, intervalMs);
  // A relay with pruning configured should still be able to exit with nothing else running.
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

async function openServer(
  options: ServeOptions,
): Promise<{ readonly server: WeftServer; readonly dispose: () => void }> {
  const skew = options.skewThresholdMs;
  if (options.databasePath === undefined) {
    return { server: new WeftServer(Date.now, skew), dispose: () => undefined };
  }
  // Imported lazily so an in-memory deployment never loads the SQLite binding.
  const { openSqliteExecutor } = await import("./node-sqlite.ts");
  const executor = openSqliteExecutor(options.databasePath);
  return { server: new SqliteWeftServer(executor, Date.now, skew), dispose: () => executor.close() };
}

/** `/health` answers before authentication so a probe needs no token. */
export function withHealthCheck(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (new URL(request.url).pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return handler(request);
  };
}

export function createRequestListener(
  handler: (request: Request) => Promise<Response>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (incoming, outgoing) => {
    void (async () => {
      try {
        const response = await handler(await toRequest(incoming));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        // A malformed or oversized body reaches here as a throw; the scope's state is
        // untouched because nothing was applied.
        const tooLarge = error instanceof BodyTooLarge;
        outgoing.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify({
            error: tooLarge ? "payload_too_large" : "bad_request",
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })();
  };
}

/** A push batch is JSON in memory, so an unbounded body is an unbounded allocation. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

class BodyTooLarge extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const declared = Number(headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

function addressOf(http: Server, host: string): string {
  const address = http.address();
  if (address === null || typeof address === "string") return `http://${host}`;
  return `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${address.port}`;
}

export type ConfigResult =
  { readonly ok: true; readonly options: ServeOptions } | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Configuration comes from the environment so the image needs no config file. Tokens are
 * mandatory: a relay with no way to authenticate anyone should refuse to start rather than
 * come up and reject every request.
 */
export function serveOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const errors: string[] = [];
  const port = Number(env["WEFT_PORT"] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) errors.push(`WEFT_PORT is not a port: ${env["WEFT_PORT"]}`);

  const pruneIntervalMs = numberFromEnv(env, "WEFT_PRUNE_INTERVAL_MS", errors);
  const pruneOlderThanMs = numberFromEnv(env, "WEFT_PRUNE_OLDER_THAN_MS", errors);
  const skewThresholdMs = numberFromEnv(env, "WEFT_SKEW_THRESHOLD_MS", errors);

  const jwt = jwtOptionsFromEnv(env, errors);
  const tokens = new Map<string, AuthContext>();
  const raw = env["WEFT_TOKENS"]?.trim() ?? "";
  if (jwt !== undefined && raw.length > 0) {
    // Two ways in is one more than a deployment meant to configure, and which one wins is not
    // something to leave to whichever is checked first.
    errors.push("WEFT_TOKENS and WEFT_JWT_* are both set; use one or the other");
  } else if (jwt !== undefined) {
    // Tokens are issued rather than listed, so there is no table to require.
  } else if (raw.length === 0) {
    errors.push("WEFT_TOKENS is required, as `token:scope_id:device_id` entries separated by commas");
    errors.push("or configure WEFT_JWT_ALGORITHMS with WEFT_JWT_SECRET or WEFT_JWT_PUBLIC_KEY");
  } else {
    for (const entry of raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)) {
      const [token, scope, device] = entry.split(":");
      if (!token || !scope || !device) errors.push(`WEFT_TOKENS entry is not token:scope_id:device_id: ${entry}`);
      else tokens.set(token, authContext(scope, device));
    }
    if (tokens.size === 0 && errors.length === 0) errors.push("WEFT_TOKENS held no usable entries");
  }

  if (errors.length > 0) return { ok: false, errors };
  const databasePath = env["WEFT_DB"]?.trim();
  return {
    ok: true,
    options: {
      host: env["WEFT_HOST"]?.trim() || "0.0.0.0",
      port,
      tokens,
      ...(jwt === undefined ? {} : { verifier: jwtVerifier(jwt) }),
      ...(databasePath === undefined || databasePath.length === 0 ? {} : { databasePath }),
      ...(pruneIntervalMs === undefined ? {} : { pruneIntervalMs }),
      ...(skewThresholdMs === undefined ? {} : { skewThresholdMs }),
      ...(pruneOlderThanMs === undefined ? {} : { pruneOlderThanMs }),
    },
  };
}

/** A non-negative millisecond duration from the environment, or `undefined` if unset. */
function numberFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  errors: string[],
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    errors.push(`${name} is not a duration in milliseconds: ${raw}`);
    return undefined;
  }
  return value;
}

/**
 * The JWT settings, or nothing if this deployment lists its tokens instead. The algorithms are
 * named explicitly because they are the deployment's decision: a verifier that accepts whatever
 * a token asks for is one a token can talk out of checking it.
 */
function jwtOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  errors: string[],
): JwtVerifierOptions | undefined {
  const algorithms = (env["WEFT_JWT_ALGORITHMS"]?.trim() ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  // An empty variable is an unset one. Left as a value, `WEFT_JWT_SECRET=""` satisfies every
  // check that a key was configured and hands the verifier an empty HMAC key — which anyone can
  // sign with, for any scope. A mistyped secret name in a deployment is exactly how that happens.
  const secret = emptyToUndefined(env["WEFT_JWT_SECRET"]?.trim());
  const publicKey = emptyToUndefined(env["WEFT_JWT_PUBLIC_KEY"]?.trim());
  if (algorithms.length === 0 && secret === undefined && publicKey === undefined) return undefined;

  if (algorithms.length === 0) {
    errors.push("WEFT_JWT_ALGORITHMS is required when a JWT key is set, e.g. RS256 or HS256");
  }
  for (const algorithm of algorithms) {
    if (!ALLOWED_JWT_ALGORITHMS.includes(algorithm as JwtAlgorithm)) {
      errors.push(`WEFT_JWT_ALGORITHMS names an algorithm this server cannot verify: ${algorithm}`);
    }
  }
  if (secret === undefined && publicKey === undefined) {
    errors.push("set WEFT_JWT_SECRET for HMAC algorithms, or WEFT_JWT_PUBLIC_KEY for the rest");
  }
  if (secret !== undefined && publicKey !== undefined) {
    errors.push("WEFT_JWT_SECRET and WEFT_JWT_PUBLIC_KEY are both set; use one or the other");
  }
  const symmetric = algorithms.some((algorithm) => algorithm.startsWith("HS"));
  // One key is configured, and an HMAC secret is not a public key. A list naming both kinds
  // leaves half the algorithms with a key that cannot verify them, and the deployment only finds
  // out when a token signed the other way arrives.
  if (symmetric && algorithms.some((algorithm) => !algorithm.startsWith("HS"))) {
    errors.push("WEFT_JWT_ALGORITHMS mixes HMAC and public-key algorithms; one key cannot verify both");
  }
  if (symmetric && publicKey !== undefined)
    errors.push("an HMAC algorithm needs WEFT_JWT_SECRET, not WEFT_JWT_PUBLIC_KEY");
  if (!symmetric && algorithms.length > 0 && secret !== undefined) {
    errors.push("a public-key algorithm needs WEFT_JWT_PUBLIC_KEY, not WEFT_JWT_SECRET");
  }
  // RFC 7518 §3.2: an HMAC key must be at least as long as the digest it produces. A shorter one
  // does not fail — it verifies, with less work to forge than the algorithm's name implies.
  const requiredSecretBytes = Math.max(
    0,
    ...algorithms.filter((algorithm) => algorithm.startsWith("HS")).map(hmacKeyBytes),
  );
  if (secret !== undefined && Buffer.byteLength(secret, "utf8") < requiredSecretBytes) {
    errors.push(`WEFT_JWT_SECRET must be at least ${requiredSecretBytes} bytes for ${algorithms.join(", ")}`);
  }
  if (errors.length > 0) return undefined;

  const key = secret ?? publicKey ?? "";
  const issuer = env["WEFT_JWT_ISSUER"]?.trim();
  const audience = env["WEFT_JWT_AUDIENCE"]?.trim();
  return {
    keys: () => key,
    algorithms: algorithms as JwtAlgorithm[],
    context: claimsToContext,
    ...(issuer === undefined || issuer.length === 0 ? {} : { issuer }),
    ...(audience === undefined || audience.length === 0 ? {} : { audience }),
  };
}

const ALLOWED_JWT_ALGORITHMS: readonly JwtAlgorithm[] = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
];

function hmacKeyBytes(algorithm: string): number {
  return algorithm === "HS512" ? 64 : algorithm === "HS384" ? 48 : 32;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Tokens and keys may come from files so they need not sit in the environment, where anyone
 * who can inspect the container can read them. Docker and Kubernetes secrets both mount files,
 * and a PEM public key does not fit comfortably in a variable in any case.
 */
export async function resolveTokenSource(
  env: Readonly<Record<string, string | undefined>>,
  readTokenFile: (path: string) => Promise<string>,
): Promise<Readonly<Record<string, string | undefined>>> {
  let resolved = env;
  const tokensPath = env["WEFT_TOKENS_FILE"]?.trim();
  if (tokensPath !== undefined && tokensPath.length > 0) {
    resolved = { ...resolved, WEFT_TOKENS: (await readTokenFile(tokensPath)).replaceAll(/\s+/gu, ",") };
  }
  const keyPath = env["WEFT_JWT_PUBLIC_KEY_FILE"]?.trim();
  if (keyPath !== undefined && keyPath.length > 0) {
    resolved = { ...resolved, WEFT_JWT_PUBLIC_KEY: await readTokenFile(keyPath) };
  }
  const secretPath = env["WEFT_JWT_SECRET_FILE"]?.trim();
  if (secretPath !== undefined && secretPath.length > 0) {
    resolved = { ...resolved, WEFT_JWT_SECRET: (await readTokenFile(secretPath)).trim() };
  }
  return resolved;
}

/**
 * Command-line settings, as the environment variables they stand for. Both surfaces exist for
 * different reasons: the container image is configured by environment because that is what an
 * orchestrator sets and where a mounted secret lands, and a person starting a relay by hand
 * wants flags they can discover with `--help` and read back in their shell history. Flags win,
 * because someone typing one is being more specific than the environment they inherited.
 */
export function envFromArgv(argv: readonly string[]): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument.slice(2) : argument.slice(2, separator);
    const variable = FLAGS[name];
    if (variable === undefined) continue;
    const value = separator < 0 ? argv[index + 1] : argument.slice(separator + 1);
    if (value === undefined || value.startsWith("--")) continue;
    if (separator < 0) index += 1;
    overrides[variable] = value;
  }
  return overrides;
}

const FLAGS: Readonly<Record<string, string>> = {
  host: "WEFT_HOST",
  port: "WEFT_PORT",
  db: "WEFT_DB",
  tokens: "WEFT_TOKENS",
  "tokens-file": "WEFT_TOKENS_FILE",
  "jwt-algorithms": "WEFT_JWT_ALGORITHMS",
  "jwt-secret": "WEFT_JWT_SECRET",
  "jwt-secret-file": "WEFT_JWT_SECRET_FILE",
  "jwt-public-key": "WEFT_JWT_PUBLIC_KEY",
  "jwt-public-key-file": "WEFT_JWT_PUBLIC_KEY_FILE",
  "jwt-issuer": "WEFT_JWT_ISSUER",
  "jwt-audience": "WEFT_JWT_AUDIENCE",
  "prune-interval-ms": "WEFT_PRUNE_INTERVAL_MS",
  "skew-threshold-ms": "WEFT_SKEW_THRESHOLD_MS",
  "prune-older-than-ms": "WEFT_PRUNE_OLDER_THAN_MS",
};

export const USAGE = `weft relay - the WeftDB relay

  --host <address>              default 0.0.0.0
  --port <number>               default 8787
  --db <path>                   SQLite file; omitted means memory, which forgets on exit
  --skew-threshold-ms <number>  a write stamped further ahead is refused; default 5 minutes

Authentication — list the tokens, or verify signed ones. Not both:

  --tokens <entries>            token:scope_id:device_id, separated by commas
  --tokens-file <path>          the same, read from a mounted secret
  --jwt-algorithms <list>       e.g. RS256; the token never chooses
  --jwt-secret <value>          for HS*, or --jwt-secret-file <path>
  --jwt-public-key <pem>        for RS*/ES*, or --jwt-public-key-file <path>
  --jwt-issuer <value>          required 'iss', if set
  --jwt-audience <value>        required 'aud', if set

Tombstone pruning — the only thing that advances a scope's floor, so it runs by default:

  --prune-interval-ms <number>  how often every scope is swept; default 24 hours, 0 turns it off
  --prune-older-than-ms <n>     how old a tombstone must be to be swept; default 30 days

Every flag has an environment variable of the same name (WEFT_PORT, WEFT_JWT_ISSUER, …), which
is what the container image is configured with. A flag wins over the environment.
`;

export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const configured = { ...env, ...envFromArgv(argv) };
  const source = await resolveTokenSource(configured, async (path) =>
    (await import("node:fs/promises")).readFile(path, "utf8"),
  ).catch((error: unknown) => {
    process.stderr.write(
      `weft relay: could not read a configured file: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return configured;
  });
  const config = serveOptionsFromEnv(source);
  if (!config.ok) {
    for (const error of config.errors) process.stderr.write(`weft relay: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  const running = await startRelay(config.options).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`weft relay: could not start: ${detail}\n`);
    if (config.options.databasePath !== undefined) {
      process.stderr.write(`weft relay: check that ${config.options.databasePath} is writable by this user\n`);
    }
    process.exitCode = 1;
    return undefined;
  });
  if (running === undefined) return;
  const storage = config.options.databasePath ?? "memory (nothing is persisted)";
  process.stdout.write(`weft relay: listening on ${running.url}, storage ${storage}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void running.close().then(() => process.exit(0));
    });
  }
}
