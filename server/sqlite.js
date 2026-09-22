/** A minimal D1-compatible adapter around Node's built-in SQLite, shared by local mode and tests. */
import {DatabaseSync} from 'node:sqlite';
export function createSqlite(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    async first() { return database.prepare(this.sql).get(...this.values) ?? null; }
    async all() { return {results: database.prepare(this.sql).all(...this.values)}; }
    async run() { const result = database.prepare(this.sql).run(...this.values); return {success: true, meta: {changes: Number(result.changes)}}; }
  }
  return {prepare: sql => new Statement(sql), exec: sql => database.exec(sql),
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        // No await inside the synchronous SQLite transaction: other requests cannot interleave.
        for (const stmt of statements) {
          const result = database.prepare(stmt.sql).run(...stmt.values);
          results.push({success: true, meta: {changes: Number(result.changes)}});
        }
        database.exec('COMMIT'); return results;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    }, close: () => database.close(), raw: database};
}
