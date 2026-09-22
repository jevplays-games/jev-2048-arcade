import {canonical} from '../public/core/rules.js';
import {createEvents, ZERO_HASH} from '../public/core/audit.js';
export class HttpError extends Error {
  constructor(status, message, code = 'request_error', details = null) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export class Store {
  constructor(db) { this.db = db; }
  stmt(sql, values = []) { return this.db.prepare(sql).bind(...values); }
  async get(sql, values = []) { return this.stmt(sql, values).first(); }
  async all(sql, values = []) { return (await this.stmt(sql, values).all()).results; }
  async run(sql, values = []) { return this.stmt(sql, values).run(); }
  async batch(items) { return this.db.batch(items.map(([sql, args]) => this.stmt(sql, args))); }
  async limit(key, maximum, seconds = 60) {
    const window = Math.floor(Date.now() / (seconds * 1000));
    const row = await this.get(`INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,
      window_start=excluded.window_start RETURNING count`, [key, window]);
    if (row.count > maximum) throw new HttpError(429, 'Usage limit reached. Retry after the current quota window.', 'rate_limit');
  }
  async events(matchId) {
    return (await this.all('SELECT event_json FROM events WHERE match_id=? ORDER BY seq', [matchId])).map(r => JSON.parse(r.event_json));
  }
  async *streamEvents(matchId, headSequence) {
    let after = 0;
    while (after < headSequence) {
      const rows = await this.all('SELECT seq,event_json FROM events WHERE match_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 50',
        [matchId, after, headSequence]);
      if (!rows.length) throw new Error('Evidence snapshot has a missing page.');
      for (const row of rows) { yield JSON.parse(row.event_json); after = row.seq; }
    }
  }
  async append(matchId, leaseToken, records, clockId, extraStatements = []) {
    const m = await this.get('SELECT event_seq,event_head FROM matches WHERE id=? AND lease_token=? AND lease_expires>?',
      [matchId, leaseToken, Date.now()]);
    if (!m) throw new HttpError(409, 'The round lease changed; reload the authoritative match.', 'lease_lost');
    const events = await createEvents({seq: m.event_seq, hash: m.event_head}, records, {matchId, clockId});
    if (!events.length) return [];
    const statements = events.map(e => [
      `INSERT INTO events(match_id,seq,type,event_json,prev_hash,hash)
       VALUES((SELECT id FROM matches WHERE id=? AND lease_token=? AND lease_expires>?),?,?,?,?,?)`,
      [matchId, leaseToken, Date.now(), e.seq, e.type, canonical(e), e.prevHash, e.hash]
    ]);
    const last = events.at(-1);
    statements.push(['UPDATE matches SET event_seq=?,event_head=? WHERE id=? AND lease_token=?',
      [last.seq, last.hash, matchId, leaseToken]], ...extraStatements);
    try { await this.batch(statements); }
    catch { throw new HttpError(409, 'Concurrent state change prevented the commit.', 'commit_conflict'); }
    return events;
  }
}
export {ZERO_HASH};
