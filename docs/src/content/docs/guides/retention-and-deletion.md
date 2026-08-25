---
title: Retention and deletion
description: Delete-wins, restore, tombstone pruning, and how a device computes and pushes its own retention deletes.
sidebar:
  order: 12
---

A delete stamps a marker on a row rather than removing anything from it. The marker sits on a
register separate from the row's fields, so a delete never has to be compared against a field
edit, and a field edit never has to be compared against a delete. Calling
`client.delete(tableName, rowId)` sends the marker; the row's stored field values stay where they
are until the row is later pruned.

## Deleting a row

On the relay, a delete only sets the row's `deleted_hlc` column and moves the row's sequence
number forward. It never touches the field values stored for that row. This is what makes restore
complete: if a delete purged fields immediately, a device that reconnects and pushes one changed
field would bring the row back holding only that field.

When a device pulls a row that was deleted elsewhere, delete wins outright if the device has no
unsent edits to that row: the local copy is dropped and replaced with a tombstone, a record that
the row was deleted rather than merely absent. If the device does have unsent edits to that row,
they are moved to [quarantine](/guides/handling-conflicts/) instead of being discarded; that guide
covers what the interface offers for a quarantined edit.

## Hiding the children of a deleted row

Deleting a row does nothing to rows that reference it. `client.listRows()` returns every row of a
collection, whether or not the row it points at still exists, so a child of a deleted parent keeps
appearing in reads until something removes it.

`visibleChildren(liveParents, children, foreignField)`, exported from `weftdb/client`, filters a
list of child rows down to those whose foreign field names a row in the parent list. An application
calls it where it reads:

```ts
import { visibleChildren } from "weftdb/client";

const entries = client.listRows(tableName("entries"));
const foods = visibleChildren(entries, client.listRows(tableName("foods")), fieldName("entry_id"));
```

Nothing calls it for you, and no query path applies it implicitly.

## Restoring a row

`client.restore(tableName, rowId, values)` clears the marker and re-creates the row locally from
the field values passed to it, which the caller supplies because the device already dropped its
own copy of them when it deleted the row. The generated per-collection helpers expose `create`,
`update`, and `delete`; restoring a row means calling `client.restore()` directly.

On the relay, a restore clears `deleted_hlc` and re-stamps the sequence number of every field the
row still holds. That re-stamp is what lets a different device, one that dropped the row's fields
locally when the delete first arrived, receive the row whole the next time it pulls, rather than
empty.

## Pruning tombstones

`relay.pruneTombstones(scopeId, olderThanMs?)` permanently deletes every row whose
`deleted_hlc` is older than the cutoff, along with its field rows, and advances the tombstone
floor for that [scope](/concepts/scopes/) to cover them. `olderThanMs` defaults to 30 days and
accepts a different value:

```ts
import type { ScopeId } from "weftdb/core";
import type { SqliteWeftServer } from "weftdb/server/sqlite";

function pruneOldTombstones(relay: SqliteWeftServer, scopeId: ScopeId): void {
  relay.pruneTombstones(scopeId);
}
```

`startRelay`, from `weftdb/server/serve`, runs this on a schedule. Each tick sweeps every scope the
server knows about, passing `pruneOlderThanMs` to each call, and closing the relay stops the
schedule along with everything else it runs. The interval defaults to a day, and the protocol
depends on the sweep happening: a scope's tombstone floor advances nowhere else, and a device below
that floor is what makes a snapshot resync necessary.

```ts
import type { ServeOptions } from "weftdb/server/serve";

const options: ServeOptions = {
  host: "0.0.0.0",
  port: 8787,
  tokens: new Map(),
  pruneIntervalMs: 6 * 60 * 60 * 1000,
  pruneOlderThanMs: 7 * 24 * 60 * 60 * 1000,
};
```

Setting `pruneIntervalMs` to `0` turns the sweep off. A relay that never prunes keeps every
tombstone it has ever written and leaves its floor at zero, so storage grows without bound and no
device is ever told to resync.

A deployment that wants a different schedule than `startRelay` runs, or that embeds `WeftServer`
directly rather than through `startRelay`, calls `pruneTombstones` itself instead, for example on
its own timer.

A device whose last pull cursor sits below the tombstone floor cannot be brought forward with an
incremental pull, because the rows it missed no longer exist to describe. Its next sync response
tells it to fall back to a snapshot resync instead. A device that has been away longer than the
pruning window meets this the next time it connects.

## Excluding event-log rows

A row created with `S.eventLog()` cannot be deleted or restored. Calling either method on one
throws before any operation is queued, matching the relay's own refusal to accept a write against
such a row from any transaction other than the one that created it. Retention treats them the same
way: the function described below skips event-log collections entirely.

## Computing retention deletes

Retention is computed on the device, not on the relay. The relay holds one generic table per field
and never learns which field on a collection means a timestamp, so it has no basis for deciding
which rows have expired. The `retentionAnchor` option marks the field an expiry date is measured
from; see [Defining a schema](/guides/defining-a-schema/) for the annotation itself. The option is
not read by `weft generate` and adds nothing to the generated types or SQL: it exists only for the
function below to read off the schema at runtime.

`planRetentionDeletes(client, schema, policy, nowMs?)` returns the rows past their expiry date. It
does not delete anything on its own:

```ts
import { planRetentionDeletes, type WeftClient } from "weftdb/client";
import type { SchemaDefinition } from "weftdb/schema";

function expiredRowCount(client: WeftClient, schema: SchemaDefinition): number {
  return planRetentionDeletes(client, schema, { defaultAutoDeleteDays: 30 }).length;
}
```

For each collection that has a `retentionAnchor` field, the function computes an expiry date from
the later of the anchor field's value and `_weft_first_synced_at`, and compares it against
`nowMs`. Taking the later of the two is what stops a months-old, not-yet-synced row from expiring
within one cycle of finally reaching the device: its expiry moves to the day the relay first
acknowledged the row, rather than the day the anchor field says it happened. A row whose
`_weft_first_synced_at` is still `null`, because the device created it and it has not yet been
acknowledged, is skipped.

The number of days is read from a field named `auto_delete_days` by default, which is an ordinary
nullable number field with no special schema annotation, the way the demo's `todos` collection
declares it. A different field name can be supplied as `autoDeleteDaysField`, and a
`defaultAutoDeleteDays` in the policy covers rows whose field holds no usable value. Because that
field merges like any other, by last-write-wins, every device that has synced converges on the
same number and therefore the same expiry date. `applyRetentionDeletes`, described below, plans
and issues these deletes in one call.

## Issuing retention deletes

`applyRetentionDeletes(client, schema, policy, nowMs?)` runs `planRetentionDeletes` and then calls
`client.delete()` for every row it returns. The deletes land in the outbox the same way any other
edit does and reach the relay on the next sync. It returns the candidates it acted on.

```ts
import { applyRetentionDeletes, type WeftClient } from "weftdb/client";
import type { SchemaDefinition } from "weftdb/schema";

function expireOldRows(client: WeftClient, schema: SchemaDefinition): void {
  applyRetentionDeletes(client, schema, { defaultAutoDeleteDays: 30 });
}
```

Each deleted row gets its own transaction id, the same one an unqualified `client.delete()` call
would give it. The rows in one sweep expire for unrelated reasons and are not steps of a single
logical change, so there is nothing for a shared transaction id to mean here. Calling
`applyRetentionDeletes`, and how often, is left to the application; nothing in the library
schedules that call.
