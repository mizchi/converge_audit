import type { EncounterLedger, EncounterLedgerRow } from "./contracts.ts";

/** Compatible with DurableObjectStorage.sql; Node tests use DatabaseSync. */
export interface EncounterSql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}

export class SqliteEncounterLedger implements EncounterLedger {
  private readonly sql: EncounterSql;
  constructor(sql: EncounterSql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS encounter_tickets_v1 (
      id TEXT PRIMARY KEY, start_key TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL, data TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS encounter_origins_v1 (
      id TEXT PRIMARY KEY, start_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, data TEXT NOT NULL
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS encounter_origin_unit_v1 ON encounter_origins_v1 (json_extract(data, '$.ticket.unit'))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS encounter_ticket_generation_v1 ON encounter_tickets_v1
      (json_extract(data, '$.ticket.unit'), COALESCE(json_extract(data, '$.ticket.generation'), 0))`);
  }
  private read(query: string, key: string): EncounterLedgerRow | undefined {
    const row = this.sql.exec(query, key).toArray()[0];
    return row ? JSON.parse(row.data as string) as EncounterLedgerRow : undefined;
  }
  byId(id: string) { return this.read("SELECT data FROM encounter_tickets_v1 WHERE id = ?", id) ?? this.read("SELECT data FROM encounter_origins_v1 WHERE id = ?", id); }
  byStart(key: string) { return this.read("SELECT data FROM encounter_tickets_v1 WHERE start_key = ?", key) ?? this.read("SELECT data FROM encounter_origins_v1 WHERE start_key = ?", key); }
  insert(row: EncounterLedgerRow): boolean {
    return this.sql.exec(`INSERT INTO encounter_tickets_v1 (id, start_key, revision, data)
      SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM encounter_origins_v1 WHERE id = ? OR start_key = ?)
      ON CONFLICT DO NOTHING RETURNING id`,
    row.ticket.ticketId, row.startKey, row.revision, JSON.stringify(row), row.ticket.ticketId, row.startKey).toArray().length === 1;
  }
  replace(expectedRevision: number, row: EncounterLedgerRow): boolean {
    if (row.revision !== expectedRevision + 1 || !Number.isSafeInteger(row.revision)) {
      throw new Error("invalid ledger revision");
    }
    const bindings = [row.revision, JSON.stringify(row), row.ticket.ticketId, row.startKey, expectedRevision] as const;
    if (this.sql.exec(`UPDATE encounter_tickets_v1 SET revision = ?, data = ?
      WHERE id = ? AND start_key = ? AND revision = ? RETURNING id`,
    ...bindings).toArray().length === 1) return true;
    return this.sql.exec(`UPDATE encounter_origins_v1 SET revision = ?, data = ?
      WHERE id = ? AND start_key = ? AND revision = ? RETURNING id`, ...bindings).toArray().length === 1;
  }
}
