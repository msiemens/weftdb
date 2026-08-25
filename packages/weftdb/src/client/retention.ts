import type { FieldName, RowId, TableName } from "weftdb/shared";
import type { SchemaDefinition } from "weftdb/schema";
import type { WeftClient } from "./index.ts";

export interface RetentionPolicy {
  readonly defaultAutoDeleteDays?: number;
  readonly autoDeleteDaysField?: FieldName;
}

export interface RetentionCandidate {
  readonly tableName: TableName;
  readonly rowId: RowId;
  readonly anchorMs: number;
  readonly firstSyncedAt: number;
  readonly expiresAt: number;
}

export function planRetentionDeletes(
  client: WeftClient,
  schema: SchemaDefinition,
  policy: RetentionPolicy,
  nowMs = Date.now(),
): readonly RetentionCandidate[] {
  const candidates: RetentionCandidate[] = [];
  for (const [tableNameText, collection] of Object.entries(schema.collections)) {
    // Event-log rows are never removed by any path, retention included.
    if (collection.kind === "eventLog") continue;
    const retentionAnchor = Object.entries(collection.fields).find(([, field]) => field.retentionAnchor)?.[0];
    if (retentionAnchor === undefined) continue;
    const tableNameValue = tableNameText as TableName;
    for (const [key, row] of client.rows) {
      if (!key.startsWith(`${tableNameText}\0`)) continue;
      const firstSyncedAt = row.internals._weft_first_synced_at;
      if (firstSyncedAt === null) continue;
      const anchorMs = Math.max(toEpochMs(row.fields.get(retentionAnchor as FieldName)), firstSyncedAt);
      const autoDeleteDays = resolveAutoDeleteDays(
        row.fields.get(policy.autoDeleteDaysField ?? ("auto_delete_days" as FieldName)),
        policy.defaultAutoDeleteDays,
      );
      if (autoDeleteDays === undefined) continue;
      const expiresAt = anchorMs + autoDeleteDays * 24 * 60 * 60 * 1000;
      if (expiresAt <= nowMs) {
        candidates.push({
          tableName: tableNameValue,
          rowId: row.id,
          anchorMs,
          firstSyncedAt,
          expiresAt,
        });
      }
    }
  }
  return candidates;
}

/**
 * Plans retention deletes and issues them through the client's own delete path, so the writes
 * land in the outbox and sync out like any edit an application makes itself. Retention stays on
 * the client for the same reason the planner does: the relay never learns which field means a
 * timestamp, so it has no basis for deciding a row has expired.
 *
 * Each candidate gets its own transaction id, the same as an unqualified `client.delete()` call
 * would give it. A retention sweep's candidates are unrelated rows expiring for unrelated
 * reasons, not steps of one logical change, so there is nothing for a shared transaction id to
 * mean here. Bundling them under one would also cost the whole sweep every time a single row
 * turned out already gone by another path: `pushOps` validates a transaction's ops together and
 * rejects all of them together, so one stale candidate would quarantine every row in the batch
 * instead of just itself.
 */
export function applyRetentionDeletes(
  client: WeftClient,
  schema: SchemaDefinition,
  policy: RetentionPolicy,
  nowMs = Date.now(),
): readonly RetentionCandidate[] {
  const candidates = planRetentionDeletes(client, schema, policy, nowMs);
  for (const candidate of candidates) client.delete(candidate.tableName, candidate.rowId);
  return candidates;
}

function resolveAutoDeleteDays(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return fallback;
}

function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
