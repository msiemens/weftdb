// What a device pays to be brought up from nothing: the server building a snapshot, the wire
// carrying it, and the client applying it. The serialization splits into encoding and hashing,
// measured separately below, because at these sizes neither cost is the other.
import { sha256Hex } from "weftdb/shared";
import { contentAddressSnapshot, snapshotToNdjson, type SnapshotEnvelope } from "weftdb/server/snapshot";
import { WeftServer, type Snapshot } from "weftdb/server";
import { HASH, SCOPE, benchClient, seedRows } from "../fixtures.ts";
import {
  consume,
  constant,
  duration,
  repeat,
  repeatAsync,
  type BenchConfig,
  type BenchGroup,
  type CaseResult,
} from "../harness.ts";
import { inProcessTransport } from "weftdb/client";

const GROUP = "Snapshot";

export const snapshot: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => {
    const results: CaseResult[] = [];
    for (const rows of config.snapshotSizes) {
      const server = await populatedServer(rows);
      const built = server.snapshot(SCOPE);
      const body = snapshotToNdjson(built);
      results.push(
        buildCase(config, rows, server),
        ndjsonCase(config, rows, built),
        digestCase(config, rows, body),
        serializeCase(config, rows, built),
        await applyCase(config, rows, built),
        ...sizeCases(rows, built, body),
      );
    }
    return results;
  },
};

async function populatedServer(rows: number): Promise<WeftServer> {
  const server = new WeftServer();
  const client = benchClient("device-0");
  await seedRows(client, rows);
  await client.syncWith(inProcessTransport(server), HASH);
  return server;
}

/** Gathering the scope's records out of the store. */
function buildCase(config: BenchConfig, rows: number, server: WeftServer): CaseResult {
  const samples = repeat(() => {
    const start = performance.now();
    const built = server.snapshot(SCOPE);
    const elapsed = performance.now() - start;
    consume(built.fields.length);
    return elapsed;
  }, config.budget);
  return duration(
    {
      id: `snapshot.build.${rows}`,
      group: GROUP,
      label: `Build a snapshot of ${rows.toLocaleString("en-US")} rows`,
      note: "the server scans every record it holds and keeps the ones in this scope; it holds one scope here, so the scan and the answer are the same size",
    },
    samples,
  );
}

/** Ordering the records and writing them out, without hashing anything. */
function ndjsonCase(config: BenchConfig, rows: number, built: Snapshot): CaseResult {
  const samples = repeat(() => {
    const start = performance.now();
    const body = snapshotToNdjson(built);
    const elapsed = performance.now() - start;
    consume(body.length);
    return elapsed;
  }, config.heavyBudget);
  return duration(
    {
      id: `snapshot.ndjson.${rows}`,
      group: GROUP,
      label: `Order and encode a ${rows.toLocaleString("en-US")}-row snapshot`,
      note: "records are sorted into key order and written as NDJSON; no digest is taken",
    },
    samples,
  );
}

/** The content address over those bytes, with the portable SHA-256 the protocol is defined on. */
function digestCase(config: BenchConfig, rows: number, body: string): CaseResult {
  const samples = repeat(() => {
    const start = performance.now();
    const digest = sha256Hex(body);
    const elapsed = performance.now() - start;
    consume(digest.length);
    return elapsed;
  }, config.heavyBudget);
  return duration(
    {
      id: `snapshot.digest.${rows}`,
      group: GROUP,
      label: `Digest a ${rows.toLocaleString("en-US")}-row snapshot body`,
      note: "SHA-256 in portable TypeScript, so that a browser client and a Node relay agree without either taking a dependency",
    },
    samples,
  );
}

/** What `/snapshot` actually answers with: the bytes and their digest, without the records twice. */
function envelopeOf(built: Snapshot): SnapshotEnvelope {
  const { snapshot: _snapshot, ...envelope } = contentAddressSnapshot(built);
  return envelope;
}

/** Both halves together, as `/snapshot` runs them. */
function serializeCase(config: BenchConfig, rows: number, built: Snapshot): CaseResult {
  const samples = repeat(() => {
    const start = performance.now();
    const addressed = contentAddressSnapshot(built);
    const elapsed = performance.now() - start;
    consume(addressed.body.length);
    return elapsed;
  }, config.heavyBudget);
  return duration(
    {
      id: `snapshot.serialize.${rows}`,
      group: GROUP,
      label: `Content-address a ${rows.toLocaleString("en-US")}-row snapshot`,
      note: "what GET /snapshot does: the digest and the body, each of which encodes the snapshot, so the encoding happens twice",
    },
    samples,
  );
}

/** Applying it to a device that holds nothing yet. */
async function applyCase(config: BenchConfig, rows: number, built: Snapshot): Promise<CaseResult> {
  const samples = await repeatAsync(async () => {
    const client = benchClient("device-1");
    const start = performance.now();
    await client.applySnapshot(built);
    const elapsed = performance.now() - start;
    consume(client.rows.size);
    return elapsed;
  }, config.budget);
  return duration(
    {
      id: `snapshot.apply.${rows}`,
      group: GROUP,
      label: `Apply a ${rows.toLocaleString("en-US")}-row snapshot to an empty device`,
      note: "every record is folded into the local store and into the device's clock",
    },
    samples,
  );
}

/**
 * The NDJSON body is the snapshot's own encoding; the `/snapshot` response wraps it in an
 * envelope that also carries the structured snapshot, so the bytes on the wire are the records
 * twice over.
 */
function sizeCases(rows: number, built: Snapshot, body: string): readonly CaseResult[] {
  return [
    constant(
      {
        id: `snapshot.bytes.${rows}`,
        group: GROUP,
        label: `Snapshot body for ${rows.toLocaleString("en-US")} rows`,
        note: "the NDJSON encoding the digest is taken over, uncompressed",
      },
      "bytes",
      Buffer.byteLength(body),
    ),
    constant(
      {
        id: `snapshot.wireBytes.${rows}`,
        group: GROUP,
        label: `/snapshot response for ${rows.toLocaleString("en-US")} rows`,
        note: "the envelope as the relay sends it: the NDJSON body and the digest of those bytes",
      },
      "bytes",
      Buffer.byteLength(JSON.stringify(envelopeOf(built))),
    ),
  ];
}
