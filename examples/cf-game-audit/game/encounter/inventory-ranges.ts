import type { EncounterSql } from "./ledger.ts";
import { isTime } from "./wire.ts";
export interface InventoryEmptyRange { first: number; last: number }
/** Maximal disjoint runs of retired empty ordinals. Operations inspect only
 * the predecessor and immediate successor, never all historical gaps. */
export class SqliteInventoryEmptyRanges {
  private readonly sql: EncounterSql;
  constructor(sql: EncounterSql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS encounter_inventory_empty_ranges_v1 (
      unit TEXT NOT NULL, owner TEXT NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL,
      PRIMARY KEY(unit, owner, first), UNIQUE(unit, owner, last))`);
  }
  private parse(row: Record<string, unknown> | undefined): InventoryEmptyRange | undefined {
    if (!row) return undefined;
    if (!isTime(row.first) || row.first < 1 || !isTime(row.last) || row.last < row.first) throw new Error("invalid inventory empty range");
    return { first: row.first, last: row.last };
  }
  predecessor(unit: string, owner: string, ordinal: number) {
    return this.parse(this.sql.exec(`SELECT first, last FROM encounter_inventory_empty_ranges_v1
      WHERE unit = ? AND owner = ? AND first <= ? ORDER BY first DESC LIMIT 1`, unit, owner, ordinal).toArray()[0]);
  }
  /** Called inside the same transaction that removes the source and member. */
  add(unit: string, owner: string, ordinal: number) {
    if (!isTime(ordinal) || ordinal < 1) throw new Error("invalid inventory ordinal");
    const before = this.predecessor(unit, owner, ordinal);
    if (before && before.last >= ordinal) throw new Error("inventory ordinal already retired");
    const left = before?.last === ordinal - 1 ? before : undefined;
    const right = ordinal < Number.MAX_SAFE_INTEGER ? this.parse(this.sql.exec(`SELECT first, last FROM encounter_inventory_empty_ranges_v1
      WHERE unit = ? AND owner = ? AND first = ?`, unit, owner, ordinal + 1).toArray()[0]) : undefined;
    for (const range of [left, right]) if (range) this.sql.exec("DELETE FROM encounter_inventory_empty_ranges_v1 WHERE unit = ? AND owner = ? AND first = ?", unit, owner, range.first);
    this.sql.exec("INSERT INTO encounter_inventory_empty_ranges_v1 VALUES (?, ?, ?, ?)", unit, owner, left?.first ?? ordinal, right?.last ?? ordinal);
  }
}
