# weftdb — design specification

Single-user, multi-device. No collaboration. Devices may be offline for months.
SQLite on both ends. TypeScript throughout, no raw SQL anywhere in application code.

---

## 0. Packages and naming

_Weft_ is the thread carried across the warp; two thread systems crossing to make one
fabric. The metaphor is per-field merge, and it is why the internal column prefix is
`_weft_` rather than a bare `__`: generated columns should be greppable and obviously
framework-owned in any SQLite browser.

Three published packages. What began as seven collapsed into one runtime with subpath
exports: the split was a packaging decision standing in for a layering one, and the layering
is better expressed by what each entry point is allowed to import than by a `package.json`
per boundary. A deployment still takes only the half it runs — a relay never pulls the
client in — because the subpaths are the unit of import, not the package.

```
weftdb                      runtime
  /shared                   HLC, merge functions, diff3, fractional index, protocol types
  /schema                   schema DSL, merge annotations, type-level inference
  /client                   sync client, outbox, subscription engine
  /client/sqlite            the SqlExecutor port
  /client/wasm-sqlite       OPFS SQLite in a dedicated worker
  /server                   field store, snapshot generation, skew + scope enforcement
  /server/relay             the HTTP surface as a Request -> Response handler
  /server/serve             a Node listener around it, plus its configuration
  /server/websocket         the sync socket hub
  /server/jwt               a TokenVerifier over signed JWTs
  /codegen                  client DDL, schema hash, typed row and mutator artifacts

weftdb-cli                  the `weft` binary: serve, generate, hash, server-ddl, doctor,
                            rehydrate, set-schema-hash
weftdb-react                hooks, useSyncExternalStore binding, row cache
```

The demos are workspace packages under `demos/` and are not published: `weftdb-demo-shared`
holds the identity, verifier and dev harness they have in common, and one package per demo
beside it.

All free unscoped on npm. A `@weft` scope is ambiguous from the registry API — verify via
the npm CLI before relying on it; `weftdb-*` unscoped avoids the question.

Reserved identifiers, all `_weft_`-prefixed so no domain field can collide:
`_weft_hlc_<field>`, `_weft_base_<field>`, `_weft_rev`, `_weft_dirty`,
`_weft_first_synced_at`. The codegen lint rejects any schema field beginning `_weft_`.
Framework-owned client tables are reserved: `outbox`, `outbox_quarantine`, `tombstones`,
`sync_state`.

Check GitHub org availability and search the local-first ecosystem for an existing `weft`
project before committing publicly.

---

## 1. Architecture

### 1.1 Two databases, two shapes

There is a SQLite database on the client _and_ on the server. They are not replicas and
they do not share a schema.

**Client SQLite** (WASM, OPFS-backed) holds real, typed domain tables. Every UI read hits
it; every write lands in it first and is durable immediately, online or not. It is the
source of truth for the running app, which is what makes a device usable after six months
without connectivity.

**Server SQLite** holds a **generic field store** — an EAV table of
`(scope_id, table, row_id, field) → (value, hlc, server_seq)`. It has no domain tables, no
generated DDL, and no knowledge of your schema. It is the convergence point and the
durable backup: a single file, trivially self-hosted and backed up.

|                                            | Client   | Server                              |
| ------------------------------------------ | -------- | ----------------------------------- |
| Typed domain tables                        | yes      | no                                  |
| Generic `fields` store                     | no       | yes                                 |
| `tombstones` table                         | yes      | no — deletion is `rows.deleted_hlc` |
| `outbox`, `outbox_quarantine`              | yes      | —                                   |
| `_weft_base_*`, `_weft_rev`, `_weft_dirty` | yes      | —                                   |
| `first_seen_at`                            | mirrored | authoritative                       |

The client-only columns are local by intent. `_weft_base_notes` is _this device's_
last-synced value, so another device's ancestor is legitimately different. `_weft_rev` is
a render-optimisation counter with no meaning off-device.

Because the server file is EAV rather than readable domain tables, `weft rehydrate`
materialises a scope into ordinary SQLite tables using the client DDL, for inspection and
for backup verification.

SQLite on the client rather than IndexedDB because the data model is relational, because
real transactions make the `txn_id` atomicity in §5.3 meaningful, and because the same
compiled query text runs against `better-sqlite3` in tests — which matters given how much
weight the property tests carry. The cost is that OPFS `SyncAccessHandle` is worker-only,
which shapes all of §8.

### 1.2 Tables are the source of truth; there is no op log

Per-field HLC metadata lives in sidecar columns on the client row and in the field store
on the server. **Neither side keeps a log of values.** Each server field row _is_ its
current state, carrying the `server_seq` of its last update.

**Tombstones are the sole retained historical record**, and necessarily so: deletion is the
one fact current-state storage cannot express, because absence is ambiguous between
"deleted" and "never existed." Everything else — every value, every prior version — is
present-tense only.

This is what makes incremental pull and snapshot the same operation:

```
incremental:  SELECT … FROM fields WHERE scope_id = ? AND server_seq > ?
snapshot:     SELECT … FROM fields WHERE scope_id = ?
```

One code path, one predicate. Snapshot equivalence (§9, invariant 5) largely falls out by
construction rather than being a property to defend.

Log-as-truth event sourcing was rejected because a device opening twice a year would force
unbounded retention, fighting §7 all the way down.

### 1.3 The server is schema-blind — genuinely

The server does exactly five things: authenticate, check `scope_id`, check clock skew,
apply per-field HLC merge, and serve field ranges. None require types. Values are opaque
blobs; the server compares HLCs and hashes and nothing else.

Two enforcement rules look like exceptions and are not:

- **Base fields.** Every collection carries `id`, `scope_id`, and `created`, mandated by
  the framework rather than declared per schema. The server rejecting mutation of these
  three is _protocol_ knowledge — three fixed strings, universal across every collection,
  identical for every application. User-declared `immutable` fields beyond these three are
  enforced client-side only (lint plus mutator surface); the server does not know them.
- **Row class.** Append-only enforcement is derived from data, not schema. The op that
  creates a row carries `kind`, and the server stamps `rows.class` from it; thereafter any
  `set` or `delete` against an `append`-class row is rejected. The server learns the class
  from the first write rather than being told. This is per-row rather than per-table, so a
  malformed client could create mixed classes within one table — convergence is unaffected,
  and the generated mutator surface makes it unreachable in practice.

The consequences are the whole point:

- **No server DDL and no server migrations, ever.** Adding `vitamin_k` to
  `nutrition_facts` is a client deploy. The server is version-independent of your schema
  for its entire life. This permanently eliminates the schema-push problem rather than
  relocating it.
- A schema _hash_ is exchanged at handshake purely to catch client version skew. The
  server stores it as an opaque string and compares for equality.

The exception that would break this — retention — is handled client-side (§7) precisely
to avoid teaching the server which field means "timestamp."

### 1.4 Authorization is `scope_id` equality, nothing more

Every row carries a denormalised, immutable `scope_id`. Sync scope is one indexed query;
authorization is one equality check. Scope is currently the user; the naming (rather than
`owner_id`) leaves room for a membership table later without a data migration.

### 1.5 Snapshot resync is the primary path

Because the field store holds current state rather than history, a device of _any_ age can
pull incrementally and be correct about values. The only thing that forces a full snapshot
is **deletion**: tombstoned rows are hard-purged at 30 days, so a client whose
`last_server_seq` predates the tombstone floor might miss a delete. That client resyncs.

Two consequences:

- Tombstone GC needs no per-device watermarks, no acknowledgment tracking, and no
  never-returning-device eviction. Below the floor, absence-from-snapshot _is_ the
  deletion signal.
- The schema-hash handshake blocks a stale client until it updates. A rarely-used device
  hits this on nearly every open, so the service-worker update must complete _before_
  handshake. If the update check is lazy, the device appears to fail sync every time.

---

## 2. Schema DSL and codegen

The schema object is the single source of every artifact. Generation is **hybrid**:
type-level inference where types are consumed, emitted files where an artifact must exist
on disk.

**Type-level inference** produces entity types, query result types, and mutator
signatures. One source of truth, no generate step to forget.

**Emitted files** produce client DDL and the schema hash. (There are no server-side
equivalents — see §1.3.) These are easier to debug than inference when something goes wrong
on a 25-field nested record.

**There are no migration files, on either side.** Client migrations were the original plan
and were replaced by reconciliation at open: `SqliteClientStore.installSchema()` runs the
generated DDL, then adds whatever columns the current schema declares and the local database
lacks — the field itself, its `_weft_hlc_<field>` stamp, and `_weft_base_<field>` where the
field merges with diff3. A device that skipped several schema versions while offline catches
up in one pass, with no ordered list of steps to keep, no record of which have run, and
nothing to go wrong when two devices arrive at the same version by different routes.

The cost is that reconciliation only ever _adds_. It decides what is missing by column name
alone, so it never drops a removed field's column and never alters one whose declared type
changed. `lintAdditiveEvolution` in `weftdb/codegen` reports both, along with a field that
became required; nothing runs it automatically, so a project that wants that guarantee wires
it into its own build. §5.10 covers what this means for a deploy.

Per-field annotations:

- `merge:` — `lww` | `diff3` | `fracIndex` | `immutable` (§6)
- `derived:` — a select fragment, so the field is always present in the entity type rather
  than present-or-absent depending on the call site (§7)
- relationship declarations — consumed to emit relation helpers (§3.3)
- `retentionAnchor:` — marks the field a retention policy is measured from (§7)

---

## 3. Query layer

**No raw SQL in application code.** Queries are built with **Kysely**, typed from a
generated `Database` interface.

### 3.1 Two generated interfaces

`InternalDatabase` exposes every column including `_weft_hlc_*`, `_weft_base_notes`,
`_weft_rev`, `_weft_dirty`, and is used only by the sync engine. `Database` exposes domain
columns only and is what application queries see. Internals never appear in autocomplete.

### 3.2 Worker boundary

The builder runs on the main thread; `.compile()` yields `{sql, parameters}`, which is what
crosses to the worker. Compiled SQL plus params hashes to the subscription cache key.
Kysely's `sql` template escape is lint-banned.

### 3.3 Relations

Codegen emits relation helpers from the `relationships` declarations already in the schema
— `q.calorieEntries().withFoodItems()` — wrapping `jsonArrayFrom` / `jsonObjectFrom`. One
round trip, fully typed. Joining in JS across two subscriptions is not an option: it
doubles the invalidation paths.

### 3.4 Nested record reassembly

`nutrition_facts` is 25 flat columns in storage and one nested object in the API.
Reassembly happens in the row mapper — the same pass that strips `_weft_*` — typed by a
generated `RowOf<T> → EntityOf<T>` mapping. The query surface filters on flat column names;
only read results are nested.

### 3.5 Mutations

Typed mutators generated from the schema:

```ts
db.tasks.update(id, { status: "done" });
```

One worker call writes local SQLite, appends to the outbox, bumps `_weft_rev`, and
notifies. There is no raw-SQL escape hatch, so the outbox cannot be bypassed — no code
path exists that skips it.

**There is no optimistic layer and no rollback path in the normal case**: writes land in
local SQLite, which is the source of truth. But rejection is not purely bug-class, so §5.5
defines an explicit rejection taxonomy and a quarantine state.

---

## 4. Storage layout

### 4.1 Client

Codegen emits one HLC column per mergeable field, inline on the row.

```
tasks
  id                     TEXT PRIMARY KEY
  scope_id               TEXT NOT NULL          -- immutable after insert
  title                  TEXT
  status                 TEXT
  rank                   TEXT                   -- "aU:d7f2" — device suffix embedded
  notes                  TEXT
  category_id            TEXT
  ...
  _weft_hlc_title        TEXT
  _weft_hlc_status       TEXT
  _weft_hlc_rank         TEXT
  _weft_hlc_notes        TEXT
  _weft_hlc_category_id  TEXT
  ...
  _weft_base_notes       TEXT      -- diff3 ancestor, LOCAL ONLY, never pushed
  _weft_first_synced_at  INTEGER   -- mirror of server first_seen_at; nullable
  _weft_rev              INTEGER NOT NULL DEFAULT 0
  _weft_dirty            INTEGER NOT NULL DEFAULT 0
```

Nested records are **flattened into merge-addressable leaf columns** and reassembled at the
API boundary (§3.4). Two devices correcting `sodium` and `vitamin_d` must not conflict.

`_weft_dirty` cannot distinguish never-synced from synced-then-edited, which is why
`_weft_first_synced_at` exists separately. It is **server-authoritative** — written once
from a push ack or a snapshot row, never generated locally. If each device stamped its own,
devices would purge the same row on different days.

`_weft_rev` increments on every local mutation and every applied remote field, and is what
makes row identity stable across query re-execution (§8.2).

```
outbox(seq INTEGER PK AUTOINCREMENT, scope_id, table_name, row_id,
       field, value, hlc, base_hash, txn_id, kind, attempts)
       -- kind: create | set | delete | restore | append

outbox_quarantine(… same shape …, rejected_at, reason, server_value)

tombstones(scope_id, table_name, row_id, hlc, server_seq,
           PRIMARY KEY (scope_id, table_name, row_id))

sync_state(scope_id PK, last_server_seq, schema_hash, schema_version,
           device_id, hlc_last, resync_required)
```

`hlc_last` is the highest stamp the device has emitted or had accepted, and `resync_required`
records that this device's cursor is below the scope's tombstone floor. Both are read back on
hydrate: without the first, the next edit after a reload can carry a stamp below work still in
the outbox; without the second, a restart resumes pulling incrementally from a point the relay
has already purged.

Every domain table is keyed `(scope_id, id)`. A row id is unique within its scope and nowhere
else, so one database holding two scopes has two rows legitimately sharing an id.

### 4.2 Server

```
fields(scope_id, table_name, row_id, field,
       value, hlc, server_seq, txn_id,
       PRIMARY KEY (scope_id, table_name, row_id, field))
       INDEX (scope_id, server_seq)

rows(scope_id, table_name, row_id, first_seen_at, class,
     deleted_hlc, register_hlc, server_seq,
     PRIMARY KEY (scope_id, table_name, row_id))
     INDEX (scope_id, server_seq)
     -- class: 'row' | 'append', stamped from the creating op's kind
     -- deleted_hlc NULL = live. Non-NULL = tombstoned; fields are RETAINED (§5.9).
     -- register_hlc: highest HLC ever written to the liveness register, by a delete or by
     --   a restore. Without it a restore leaves no trace, and a delete that arrives later
     --   but was stamped earlier would re-bury the row (§9.23b).
     -- server_seq: last row-level change — create, delete, or restore.

scope_state(scope_id PK, server_seq, tombstone_floor_seq, schema_hash, schema_version)
devices(scope_id, device_id, last_seen, PRIMARY KEY (scope_id, device_id))
```

`server_seq` is a per-scope monotonic counter, shared by both tables: `fields.server_seq`
advances on value changes, `rows.server_seq` on row-level changes. The two together are the
complete change stream (§5.6). `tombstone_floor_seq` is the highest `server_seq` of any
tombstoned row that has been hard-purged — a client below it must resync (§1.5).

There is no separate server `tombstones` table: deletion is a row-level register on `rows`
(§5.9). The client keeps one, because it hard-deletes rows from its typed domain tables and
needs somewhere to remember that it did.

All primary keys carry `scope_id`, because server storage is multi-scope and row ids are
only unique within a scope. The client is partitioned per scope and does not strictly need
it, but uniformity beats two schemas.

### 4.3 Database partitioning (client)

One OPFS file per scope. Switching accounts switches files, leaving any pending outbox
intact. Cross-scope leakage becomes structurally impossible rather than a check that must
be remembered, and the outbox survives session expiry (§10) without risk of pushing one
scope's rows under another's token.

### 4.4 Clocks

HLC as `(wall_ms, counter, device_id)`, encoded as a fixed-width lexicographically
comparable string. Ties broken by `device_id`; the counter increments when `wall_ms` does
not advance. Vector clocks were rejected — bounded size matters more than causality
precision across a handful of personal devices.

**HLC totally orders and therefore cannot detect concurrency.** It cannot answer "did this
edit see that one?" That is why diff3 needs the separate base-hash mechanism in §5.4; do
not attempt to infer concurrency from HLC comparison.

Client-generated, with server-side rejection of any op stamped beyond `SKEW_THRESHOLD`
ahead of server time. Server receive-time as a tiebreak was rejected because it means
"whoever reconnected last wins," which after a six-month gap is backwards.

The encoding is exactly 15 base-36 digits of wall clock, 6 of counter, and the device id.
Both widths are load-bearing: they are what makes string comparison equivalent to tuple
comparison, and a segment of any other width orders against every other reading arbitrarily.
Two consequences follow. A stamp that is not in canonical form is refused at every boundary it
crosses — a reading that parses to `NaN` is folded into a clock with `Math.max`, which makes
every later stamp on that device `NaN` too, and no valid write afterwards recovers from it. And
a counter that runs out of digits carries into the wall clock rather than taking a seventh, so
the stamp stays strictly above the one it came from and still fits its columns.

---

## 5. Wire protocol

**No whole-row writes in the push path, ever.** Snapshots are full-state downloads and
travel server→client only; they never move upward, so the guarantee is directional.

The push stream carries **two op classes**, mirroring the server's two tables:

- **Row ops** — `create`, `delete`, `restore`, `append`. They carry no values, only
  `(table, row_id, hlc)` and, for `create`/`append`, the `class`. They mutate `rows` alone.
- **Field ops** — `set`. One field, one value, one HLC, optionally a `base_hash` (§5.4).
  They mutate `fields` alone.

Creating a row is therefore a `create` row op **bundled in the same `txn_id`** as the `set`
ops carrying its initial values — never a single whole-row payload. The atomicity rule in
§5.3 makes the bundle indivisible, so a row never exists without its creating fields, and
the per-field guarantee is preserved: a stale client still pushes only fields it knows,
and a `create` conveys existence rather than content.

This is what makes a stale client structurally incapable of clobbering fields it does not
know exist.

### 5.1 Handshake

```
client → { scope_id, device_id, schema_hash, schema_version, last_server_seq }
server → { ok, server_seq }                     -- incremental
       | { schema_mismatch }                    -- client must update
       | { resync_required, snapshot_url }      -- last_server_seq < tombstone_floor_seq
```

### 5.2 Snapshot contents

Specified exactly, because invariant 5 is otherwise untestable. Taken in a **single read
transaction** so it is a consistent point-in-time cut — a snapshot straddling a write
breaks equivalence in a way that never reproduces. NDJSON, streamable, content-addressed.

- every `fields` row for the scope: table, row_id, field, value, hlc
- every `rows` record: table, row_id, `first_seen_at`, `class`, `deleted_hlc`
- tombstoned rows surviving the floor appear as ordinary `rows` records with `deleted_hlc`
  set, and their fields are included — restore must be able to return the row whole. A
  client distinguishes live from tombstoned by `deleted_hlc IS NULL`, never by absence.
- header: `server_seq` at snapshot instant, `tombstone_floor_seq`, `schema_hash`
- event-log collections in full
- **no** client-only columns (`_weft_base_*`, `_weft_rev`, `_weft_dirty`)

### 5.3 Push

Ops batched by `txn_id` and applied atomically, so a `calorie_entry` and its `food_items`
never appear half-created. Per op the server:

1. rejects if `op.scope_id != token.scope_id`
2. rejects if `hlc.wall_ms > server_now + SKEW_THRESHOLD`
3. rejects mutation of a base field on an existing row — `id`, `scope_id`, `created`,
   the three framework-mandated fields (§1.3)
4. rejects `delete`, `restore`, or a _later-transaction_ `set` against a row whose
   `rows.class` is `append`; stamps `class` from the op kind when the row is new. `set` ops
   sharing the creating `txn_id` are accepted (§5.9).
   4b. rejects `set` against an absent row (`row_absent`) and `create` against a present one
   (`row_exists`) — see §5.9
5. if `base_hash` is present, compares it to `hash(current value)`; mismatch → `merge_required`
6. otherwise applies field-wise by HLC comparison, assigns `server_seq`, sets
   `rows.first_seen_at` if absent, and returns it in the ack

Steps 3–5 are all schema-blind: they compare opaque strings and hashes.

### 5.4 diff3 and the rebase protocol

HLC cannot detect concurrency (§4.4), so server-side LWW on a `diff3` field would silently
discard one of two concurrent prose edits. Instead, `diff3` fields carry a **base hash**:
push sends `{value, hlc, base_hash}` where `base_hash = hash(_weft_base_notes)`.

- **match** → fast-forward; accept and store the new value.
- **mismatch** → reject `merge_required`, returning the current server value. The client
  diff3-merges locally against its own `_weft_base_notes`, updates the base, and re-pushes.

This is `push --ff-only` with client-side rebase. The server never stores an ancestor,
compares only two opaque hashes, and no edit can be discarded. Rebase retries are bounded
at 3; beyond that the op is quarantined (§5.5) rather than looping.

### 5.5 Rejection taxonomy

**Rejection granularity is the transaction, never the individual op.** The server applies
a `txn_id` batch atomically (§5.3); if any op in it is rejected, the entire batch is
rejected and none of it is applied. Partial application, and therefore partial quarantine
within a transaction, cannot occur. This is what makes the dirty-tracking rule in §5.8
decidable.

Local writes are already committed, so rejection needs defined handling per class.

| Class          | Cause                                                                                                                       | Handling                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Rebase**     | `merge_required`                                                                                                            | Automatic local diff3 merge, update base, retry. Bounded at 3, then quarantine.                |
| **Retryable**  | clock skew                                                                                                                  | Re-stamp with corrected clock and retry. The op was never accepted anywhere, so no divergence. |
| **Blocked**    | schema mismatch                                                                                                             | Whole session halts. Ops stay pending, untouched. Resolved by client update.                   |
| **Quarantine** | scope mismatch, base-field violation, append-class violation, `row_absent`, `row_exists`, rebase exhaustion, `malformed_op` | Move to `outbox_quarantine`, surface in UI, never auto-retry.                                  |

Quarantine means local state has permanently diverged from the server. The UI must offer
repair — discard the local change and re-pull, or export it — and must never fail silently.

### 5.6 Pull — incremental

Two ranges over the same counter, both required:

```
fields  WHERE scope_id = ? AND server_seq > last_server_seq   -- value changes
rows    WHERE scope_id = ? AND server_seq > last_server_seq   -- create / delete / restore
```

Field changes apply by HLC comparison; higher wins. Row records carry `first_seen_at`,
`class`, and `deleted_hlc`, and are the **only** way row-level state reaches a device that
did not originate it — a row created on another device would otherwise arrive as fields with
no `_weft_first_synced_at`, breaking retention (§7). `deleted_hlc` transitions are applied to
the client's typed tables as delete or restore.

Local unsent outbox entries are **not** overwritten — they replay on top.

Applying a batch also folds its HLCs into the local clock. A device that pulled a value and
then edited it must stamp the edit above what it just saw, or the edit loses the field-wise
comparison while the push still reports success — silent, permanent divergence.

Every batch carries the scope's `tombstone_floor_seq`, and a client below it **must not
apply the batch**: what it missed has been hard-purged, so the incremental stream cannot
describe those absences and advancing the cursor would strand purged rows locally forever.
The floor can advance between the handshake and the read, so this check belongs on the pull
path as well as the handshake (§5.1), and the session falls back to a snapshot (§5.7).

The entire pull batch applies in one client transaction and emits **one** notification
(§8.4), regardless of how many server transactions it spans.

### 5.7 Pull — snapshot resync

Tombstoned rows are **present** in the snapshot with `deleted_hlc` set (§5.2), so liveness is
read from that register, never inferred from absence. Three cases, split on liveness and
dirtiness:

| Snapshot row          | Clean local row                                                           | Dirty local row                                              |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `deleted_hlc IS NULL` | Server state wins wholesale.                                              | Apply, then replay outbox on top (step 4).                   |
| `deleted_hlc` set     | Apply the delete locally: remove the typed row, write a client tombstone. | **Quarantine** — deleted remotely, edited locally.           |
| absent entirely       | Delete: the row was hard-purged below the floor.                          | **Quarantine** — same reason, purged rather than tombstoned. |

1. Apply the table above, row by row.
2. Absence still means deletion, but now only for rows purged below the floor — a live/deleted
   distinction is never drawn from presence.
3. Every quarantined case surfaces in the UI with restore-or-discard (§7); nothing is
   silently dropped.
4. Replay the local outbox on top as per-field ops, HLC-compared normally.
5. Event-log collections are **exempt from all delete branches** — never removed by absence
   or by a tombstone.
6. Emit a single notification on completion, never one per row.

Step 4 is what prevents months-old unsynced edits from being discarded as stale. The
outbox, not the clock, is the authority on unsent intent.

### 5.8 Acknowledgment, `first_seen_at`, and dirty tracking

`first_seen_at` is **row-level and server-authoritative**. On the first op touching
`(scope_id, table, row_id)`, the server stamps it from its own clock. Every op in the same
`txn_id` that touches that row receives the _same_ value in the ack — it is a property of
the row, not of any field.

The client writes `_weft_first_synced_at` once, from a push ack or a snapshot row, and
never rewrites it. It is never generated locally: if each device stamped its own, devices
would compute different expiry dates for the same row (§7).

Dirty tracking is a derived predicate, recomputed after every ack and every quarantine
move:

```
_weft_dirty = EXISTS(outbox entry for row) OR EXISTS(quarantine entry for row)
```

Quarantined ops keep a row dirty deliberately. A row with quarantined ops has diverged from
the server, and must not be overwritten wholesale by a later snapshot (§5.7 step 1) —
leaving it dirty routes it into step 3 instead, where the divergence is surfaced rather than
erased.

Because rejection is per-transaction (§5.5), a row is never left half-acknowledged: either
the whole batch applied and its outbox entries drained, or none of it did.

### 5.9 Delete, restore, and row lifecycle

Delete-wins and per-field HLC merge would contradict each other if both operated on the
same data. They do not: **deletion is a row-level LWW register on a separate axis.**

```
rows.deleted_hlc   NULL = live;  non-NULL = tombstoned at that HLC
```

**A delete does not remove fields.** It stamps `deleted_hlc` and leaves every field value in
place. This is what makes restore complete: if delete purged fields, a returning device
pushing one changed field would resurrect a row containing only that field. Fields are hard-
purged only at prune (below).

Op kinds are `create | set | delete | restore | append`.

| Op        | Server behaviour                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`  | Row must be absent. Inserts `rows`, stamps `first_seen_at` and `class`. `row_exists` if present, live or tombstoned.                                                                                                                                                                                                |
| `set`     | Row must be present. Applies field-wise by HLC. **Never clears `deleted_hlc`** — writing to a tombstoned row does not restore it. `row_absent` if the row is gone.                                                                                                                                                  |
| `delete`  | LWW on the register: applies only if `op.hlc > register_hlc`. Sets `deleted_hlc` and `register_hlc`, advances `rows.server_seq`. Fields untouched.                                                                                                                                                                  |
| `restore` | LWW on the register: applies only if `op.hlc > register_hlc`. Clears `deleted_hlc`, stamps `register_hlc`, advances `rows.server_seq`, and re-stamps the retained fields' `server_seq` so an incrementally-pulling client — which dropped them when the delete arrived — gets the row back whole rather than empty. |
| `append`  | Creates a row with `class = 'append'`. Never deletable, never restorable (§6).                                                                                                                                                                                                                                      |

**Append rows still need values**, which the `set` rejection in §5.3 would otherwise forbid.
The rule is scoped by transaction: `set` ops are accepted against an `append`-class row
**only within the same `txn_id` as its `append` op**. Afterwards every `set` is rejected. An
event-log row is therefore written once, atomically, and is immutable from the next
transaction onward — which is exactly the semantics `S.EventLog()` promises.

The two registers are independent, and that independence is the whole point:

- **A late field write does not resurrect.** A device offline across a delete pushes `set`
  ops; they apply to fields, `deleted_hlc` stays, the row stays gone. No HLC comparison
  between a field and a tombstone is ever needed, which is what removes the divergence.
- **A late write is not silently lost either.** The client detects on pull that a row it
  holds dirty edits for is tombstoned, and routes it to quarantine (§7). The user chooses:
  discard, or restore — which emits an explicit `restore` op stamped now, therefore
  necessarily greater than `deleted_hlc`, therefore winning.
- **Concurrent delete and restore** converge by HLC on the single register, like any LWW
  field. There is no ordering ambiguity because there is only one register.

**Prune.** At 30 days a tombstoned row is hard-purged: the `rows` entry and every field row
for it are deleted, and `tombstone_floor_seq` advances to that row's `server_seq`. After
this the server has no memory of the row id at all.

That amnesia is exactly why `set` on an absent row must be rejected. Two clients could
otherwise resurrect:

- A client **below the floor** is forced to resync (§1.5) and discovers the absence through
  snapshot diffing, so it never pushes blind.
- A client **above the floor** that has not pulled since the delete would push `set` into a
  void and recreate the row. `row_absent` stops it: the client pulls, finds the row gone, and
  quarantines its dirty edits like any other case.

`row_absent` and `row_exists` are quarantine-class rejections (§5.5), not retryable — both
indicate the client's view of row existence has diverged from the server's.

### 5.10 Schema hash lifecycle

`scope_state.schema_hash` is **client-established, not server-configured** — otherwise
schema changes would require a server deploy, defeating §1.3. It is paired with a monotonic
`schema_version` taken from client build metadata, because a bare hash deadlocks on
rollback: roll the client back, and the server holds a hash no client can produce.

At handshake, comparing the client's `(hash, version)` against the scope's:

| Condition                       | Outcome                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Scope has no hash yet           | Adopt the client's. First client to sync establishes it.                                                            |
| `version` equal, `hash` equal   | `ok` — normal path.                                                                                                 |
| `version` greater               | Adopt hash and version. The upgraded client rolls the scope forward.                                                |
| `version` lower                 | `schema_mismatch`. Client must update; its outbox is untouched (§5.5).                                              |
| `version` equal, `hash` differs | `schema_mismatch`, hard. Indicates divergent builds at the same version — a build-pipeline bug, not a stale client. |

Rolling updates therefore work in one direction only, which is the intent: the first
upgraded device rolls the scope forward, and every other device is locked out until it
updates. For a rarely-opened device this is the normal experience, which is why the
service-worker update must precede handshake (§1.5).

**Rollback requires an explicit operator action** — `weft set-schema-hash` — rather
than being reachable by deploying old client code. This is deliberate: silent backward
movement would let an old client push data missing fields that newer clients require.

---

## 6. Merge rules

Merge strategy is a **schema annotation, never a value type**. Runtime values stay plain
`string`, `number`, `Date`. This is the deliberate escape from the failure mode where
CRDT-typed values propagate into every call site. diff3 works by diffing
previous-against-new on write, so even the merging field keeps a plain string API.

| Strategy    | Applies to                                    | Behaviour                                                |
| ----------- | --------------------------------------------- | -------------------------------------------------------- |
| `lww`       | default; `user_notes`, numerics, enums, dates | Higher HLC wins.                                         |
| `diff3`     | `tasks.notes`                                 | Base-hash rebase (§5.4). Markers on overlapping hunks.   |
| `fracIndex` | `tasks.rank`, `custom_views.rank`             | Lexicographic sort; device suffix embedded in the value. |
| `immutable` | `id`, `scope_id`, `created`                   | Write-once; later writes rejected.                       |

Insert-only is a **collection** property, not a merge strategy: `S.eventLog()` sets the row
class, and §5.9 covers what the relay enforces from it. Only the three base fields above are
`immutable` on the relay; `_weft_first_synced_at` is internal row metadata rather than a
schema field, so it is never compared against `BASE_FIELDS`.

**diff3 over LWW for prose.** Two devices editing the same note under LWW silently discard
one entire version. diff3 merges cleanly when edits touch different paragraphs —
overwhelmingly the common case for a single author on two devices — and degrades to visible
markers rather than silent loss. A real text CRDT is the right answer only if simultaneous
typing becomes a requirement; because the field type does not change, that is a contained
upgrade.

**Conflicts are surfaced by scanning for marker syntax at app open**, not by a stored
conflict table. The text is already the source of truth; a second record of it can only
disagree, and a per-device table would leave non-merging devices with marker-laden notes
and nothing surfacing them.

**Fractional index ordering.** The device tiebreak is **encoded into the rank value at
generation** — `"aU:d7f2"` — rather than carried in a separate column. Ordering is then a
pure lexicographic sort on one column, the tiebreak is immutable under later rank rewrites,
and midpoint generation ignores suffixes. The rank alphabet is therefore restricted to
characters that sort **above** the `:` separator, or a rank whose core is a prefix of
another's would compare in the wrong direction once the suffix is appended; and no core ends
in the first alphabet character, which is what guarantees there is always room to insert
between two neighbours. Sorting by `(rank, _weft_hlc_rank)` was rejected:
rewriting a rank changes its HLC and can reshuffle ties.

**Append-only collections** get a first-class `S.EventLog()` type rather than being an
ordinary collection the app merely refrains from updating. Insert-only enforcement is
checked server-side (§5.3 step 4) and makes convergence free.

---

## 7. Derived values, deletion, retention

`estimated_calories` is **not stored**. Recomputing a stored aggregate on merge would
require the merge layer to understand aggregations. It is a `derived` field:

```
COALESCE(manual_calorie_override, SUM(food_items.calories))
```

Being `derived` in the DSL means it is always present in the entity type, never
present-or-absent depending on which query produced the row.

`manual_calorie_override` (nullable, LWW) replaces `is_manual_entry`. Manual-ness becomes a
consequence of the data rather than an independently settable flag.

**Deletion is delete-wins with read-time orphan filtering** — for clean rows. A tombstoned
parent's children are dropped from reads and reaped lazily. Server-side, deletion is a
row-level register independent of field merge (§5.9), which is what keeps delete-wins from
contradicting per-field HLC resolution.

**Dirty rows under a remote delete go to quarantine, not the bin.** Strict delete-wins would
destroy months of unsynced work on a rarely-opened device, contradicting the reason §5.7
step 4 exists. The UI asks: _this entry was deleted on another device and you have unsynced
edits to it — restore or discard?_ Delete-wins still holds for the common clean case.

**Retention is client-driven.** The server cannot know which field means "timestamp"
without schema knowledge, and teaching it would breach §1.3. Instead a client computes
expired rows and pushes ordinary `delete` ops; the server just stamps `deleted_hlc`. The
`retentionAnchor:` annotation tells the _client_ which field to measure from.

Retention is anchored on `max(retentionAnchor, _weft_first_synced_at)`, and **no row is
purged while `_weft_first_synced_at IS NULL`**. Anchoring on the timestamp alone would purge
a months-old unsynced entry within one cycle of arriving — preserving it just long enough to
watch it vanish. `max()` collapses to the intended behaviour for normally-synced rows with
no special case. Because `first_synced_at` is server-authoritative, every device computes
the same expiry date.

`auto_delete_days` is itself LWW-synced; purge uses the converged value.

**Tombstones prune at a fixed 30-day floor**, advancing `tombstone_floor_seq`. There is no
op log to prune (§1.2).

**Blob GC runs out of band via an S3 lifecycle rule** matching the retention window —
declarative, runs without application code, cannot be broken by a sync bug. Full URLs are
stored inline: the endpoint is self-hosted, re-homing is a one-time `UPDATE`, and since
photo capture requires network for calorie analysis anyway, the "op references a
not-yet-uploaded object" ordering problem does not arise.

---

## 8. React integration

The expensive things are not query execution — re-running a query over a few thousand rows
is microseconds. They are the postMessage boundary and React re-rendering rows that did not
change.

**Full query re-execution in the worker, delta over the wire.** The worker re-runs the
query, diffs against the previous result, and ships `{added, removed, changed}` ids plus
changed row payloads. Main-thread work is proportional to the change, not the result size —
most of IVM's benefit at a fraction of the complexity.

### 8.1 Dependency tracking

`sqlite3_set_authorizer` fires per table/column access at prepare time. The accessed set is
recorded and attached to the query handle. Exact, automatic, no parsing, independent of how
the SQL was produced. Invalidation is at **table granularity** — one scope per file means
finer granularity buys nothing.

### 8.2 Row identity

Main-thread cache keyed `(table, id) → {rev, frozenObject}`. Unchanged `_weft_rev` returns
the identical object reference, so `React.memo` is effective and the delta protocol has
something to be a delta against. The row mapper strips all `_weft_*` columns before
anything reaches a component.

### 8.3 Subscriptions

`useSyncExternalStore` with a **cache-backed synchronous snapshot**: `getSnapshot` returns
the cached result or a sentinel; `subscribe` registers the query, triggers the async fetch,
notifies on arrival. Tearing-free under concurrent rendering. **Suspense is opt-in** for
call sites that prefer it. After first sync, cache hits dominate; the loading state mostly
appears on cold open, which is also when a resync is running.

### 8.4 Notification coalescing

**One notify per local transaction**, so an entry and its food items appear together, plus
**microtask batching** across transactions. Remote pulls emit one notification per batch
(§5.6); snapshot resync emits exactly one (§5.7).

### 8.5 Editing a diff3 field

**The local editor buffer wins while focused.** Remote updates are held and applied on blur,
where they go through the rebase path in §5.4. Applying remote updates live would move text
under the cursor.

The write must be debounced (~500ms) **and** flushed on blur, unmount, and
`visibilitychange`, or a device backgrounded mid-sentence loses the sentence. The
subscription must recognise self-originated cache updates so the editor does not re-render
from its own writes.

### 8.6 Sorted lists

The query result is **frozen during an active drag**, pending updates applied on drop.

### 8.7 Multi-tab — required for MVP

`SyncAccessHandle` is exclusive, so a second tab throws on open. That is Ctrl-click, not an
edge case, and it is not deferrable.

**Web Locks leader election.** The leader tab owns the OPFS handle and the worker;
non-leader tabs proxy all DB access to the leader over `BroadcastChannel`. On leader death
the lock releases and another tab acquires it, reopening the database. A degraded fallback
banner ("already open in another tab") must exist for the window where the leader is dying
and no successor has acquired.

---

## 9. Invariants for property tests

Generator: random op sequences across N simulated devices, random partition schedules,
random duplication and reordering, random offline durations spanning the tombstone floor,
random interleaving of snapshot resync and incremental pull, random rejection injection.

### Convergence

1. **Commutativity** — any delivery order of the same op set yields byte-identical state.
2. **Idempotence** — duplicate delivery of any op is a no-op.
3. **Partition tolerance** — any partition/merge schedule converges.
4. **HLC monotonicity** — per device, emitted HLCs strictly increase.
5. **Snapshot equivalence** — `snapshot(t) + outbox_replay ≡ incremental_pull(0..t) + outbox_replay`,
   over the union of the `fields` and `rows` streams.
6. **Floor independence** — pruning tombstones never changes converged state for any device
   above the floor.
7. **Stale-client safety** — a client on schema version _n_ cannot alter any field
   introduced in version _n+1_.
8. **Push is never whole-row** — no push payload contains a field the client did not
   explicitly write; row ops carry no values at all.
   8a. Every `create` or `append` op shares a `txn_id` with at least one `set`; no row is ever
   committed without its creating fields.
   8b. An `append`-class row accepts `set` only in its creating transaction, never after.

### Rebase and rejection

9. A `merge_required` rebase loses no edit from either side.
10. Rebase terminates: at most 3 retries, then quarantine.
11. A quarantined op is never applied to the server and never silently discarded.
12. A skew rejection leaves no server-side trace — retry after correction converges
    identically to having been accepted first time.
13. A `schema_mismatch` session leaves the outbox byte-identical.
14. Rejection is all-or-nothing per `txn_id`: no batch is ever partially applied.
15. A row is never simultaneously acknowledged and holding undrained outbox entries.

### Application

14. `food_items.scope_id == parent calorie_entry.scope_id`, always.
15. No `food_item` is ever _visible_ whose parent is tombstoned.
16. Manual-ness is determined solely by `manual_calorie_override IS NOT NULL`.
17. Derived `estimated_calories` equals `COALESCE(manual_calorie_override, SUM(food_items.calories))`.
18. `task_status_history` rows are never removed by any path.
19. Rank ordering is a **total** order under lexicographic `rank`; no two visible rows in a
    scope compare equal.
20. `_weft_base_notes` never appears in any outbox entry or push payload.
21. Client-side, a live typed row and a client tombstone never coexist for the same
    `(scope_id, table, id)`. Server-side, liveness is exactly `deleted_hlc IS NULL`.
22. A dirty row deleted remotely appears in quarantine, never dropped.
23. A row created by an `append` op never accepts a `set` or `delete`, from any client.
    23a. A `set` op never clears `deleted_hlc`: no sequence of field writes resurrects a row.
    23b. Delete and restore converge by HLC on a single register, for any interleaving.
    23c. A restored row returns with every field it had at deletion, not a subset.
    23g. Liveness is never inferred from presence: a tombstoned row present in a snapshot is
    applied as a delete, and a dirty row so marked is quarantined, not overwritten.
    23d. `set` against an absent row is always rejected; no op sequence recreates a purged
    row id without an explicit `create`.
    23e. Fields of a tombstoned row survive until prune, and are purged with it atomically.
    23f. Every row reaching a client carries `first_seen_at`: no device ever holds a synced row
    with `_weft_first_synced_at IS NULL`.
24. Base fields (`id`, `scope_id`, `created`) are immutable after insert, server-enforced.
25. `_weft_dirty` equals `EXISTS(outbox) OR EXISTS(quarantine)` for that row, always.

### Retention

23. No row is purged while `_weft_first_synced_at IS NULL`.
24. Purge is anchored on `max(retentionAnchor, _weft_first_synced_at)`.
    25b. `first_synced_at` is server-authoritative: all devices compute the same expiry instant,
    and every op in a `txn_id` touching one row receives an identical value.
25. Purge uses the converged `auto_delete_days`.
26. A purged row does not resurrect via any device returning from below the floor.

### Authorization and scope

28. Any op whose `scope_id` differs from the token's is rejected server-side.
29. `scope_id` is immutable after insert.
30. No local DB file ever contains rows from two scopes.
31. Two scopes with identical row ids never collide in `fields` or `rows`.
32. An op with `hlc.wall_ms > server_now + SKEW_THRESHOLD` is rejected.
33. Outbox contents survive session expiry and re-login into the same scope.

### Conflict handling

34. diff3 on non-overlapping hunks produces no markers and loses no edit.
35. diff3 on overlapping hunks produces markers preserving both sides verbatim.
36. Marker scan at open detects every note containing markers, on every device.
37. Removing markers by hand clears the conflict with no residual state.

### Reactivity

38. Authorizer-derived dependencies are a superset of tables the query reads.
39. A row whose `_weft_rev` is unchanged yields an identical object reference.
40. Worker-computed deltas applied to the previous result equal a full re-fetch.
41. No notification is emitted mid-transaction.
42. Under leader election, exactly one tab holds the OPFS handle at any instant.

### Schema lifecycle

43. `schema_version` is monotonic non-decreasing per scope across any client sequence.
44. A client at a lower `schema_version` cannot write, and its outbox is unmodified.
45. Equal version with differing hash always fails; it never silently adopts either side.

---

## 10. Sessions

Session expiry and logout are distinct. After a long gap both tokens are expired, and
re-authentication must be non-destructive: the local database is keyed by `scope_id`
(§4.3), not by session, so unsent ops sit on disk with no session present and push once
sign-in completes. The UI state is "session expired, unsynced changes preserved, sign in to
sync" — not a logout. Long-lived refresh tokens were rejected as merely moving the cliff.

---

## 11. Deferred

- **Schema evolution.** Additive only; new fields always optional; never reuse a name with a
  different type. Enforced by a codegen lint. Because the server is schema-blind, evolution
  is a client-only concern — an unknown field in the store is simply a field no current
  client reads.
- **Real collaboration.** Would reopen §6 (text CRDT), §7 (delete semantics), and scope
  membership. The `scope_id` naming keeps that door open; nothing else here does.
