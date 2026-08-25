import type { FieldName, RowId, WireValue } from "weftdb/shared";
import type { MaterializedRow } from "./index.ts";

export function isManualEntry(row: MaterializedRow, overrideField: FieldName): boolean {
  return row.fields.get(overrideField) !== null && row.fields.get(overrideField) !== undefined;
}

export function estimatedCalories(
  entry: MaterializedRow,
  foodItems: readonly MaterializedRow[],
  overrideField: FieldName,
  caloriesField: FieldName,
): number {
  const override = entry.fields.get(overrideField);
  if (typeof override === "number") return override;
  return foodItems.reduce((total, item) => {
    const calories = item.fields.get(caloriesField);
    return total + (typeof calories === "number" ? calories : 0);
  }, 0);
}

export function visibleChildren(
  liveParents: readonly MaterializedRow[],
  children: readonly MaterializedRow[],
  foreignField: FieldName,
): readonly MaterializedRow[] {
  const liveParentIds = new Set<RowId>(liveParents.map((row) => row.id));
  return children.filter((child) => {
    const parentId = child.fields.get(foreignField);
    return typeof parentId === "string" && liveParentIds.has(parentId as RowId);
  });
}

export function wireNumber(value: WireValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}
