export function mapCommentsRow(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = { ...row };
  delete output["author__label"];
  delete output["author__device"];
  assignNested(output, ["author", "label"], row["author__label"]);
  assignNested(output, ["author", "device"], row["author__device"]);
  return output;
}

function assignNested(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (segment === undefined) return;
    if (index === path.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
}
