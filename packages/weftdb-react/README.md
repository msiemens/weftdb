# weftdb-react

React bindings for WeftDB.

## Install

Use with `react` and `weftdb`.

## Query Rows

```tsx
import { queryKey } from "weftdb/client";
import { useWeftRows, type WeftSource } from "weftdb-react";
import { decodeTasks } from "./generated/bindings.ts";
import { schema } from "./schema.ts";

const tasksQuery = queryKey(schema, "tasks", ["id", "title", "notes"]);

export function TaskList({ source }: { source: WeftSource }) {
  const tasks = useWeftRows(source, tasksQuery, decodeTasks);

  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
  );
}
```

## Generic Subscription

```tsx
import { useWeftQuery, type SubscriptionSource } from "weftdb-react";

export function Counter({ source }: { source: SubscriptionSource<number, "count"> }) {
  const count = useWeftQuery(source, "count");
  return <span>{count}</span>;
}
```

## Suspense

```tsx
import { useWeftSuspenseQuery } from "weftdb-react";

const value = useWeftSuspenseQuery(source, key);
```

## Conflicts

```tsx
import { useWeftConflicts } from "weftdb-react";

const conflicts = useWeftConflicts(rows);
```

## Cache

```ts
import { QueryCache } from "weftdb-react";

const cache = new QueryCache<string>();
cache.set("status", "ready");
```
