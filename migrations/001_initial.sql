PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL,
  context_json TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proofs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT,
  payload_json TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT REFERENCES users(id),
  manifest_json TEXT NOT NULL, commitment TEXT NOT NULL, seed_cipher TEXT NOT NULL,
  state_json TEXT NOT NULL, revision INTEGER NOT NULL, ranked INTEGER NOT NULL CHECK(ranked IN (0,1)),
  mode TEXT NOT NULL CHECK(mode IN ('jev','local')), guild_id TEXT, channel_id TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  pending_json TEXT, lease_token TEXT, lease_expires INTEGER, verified INTEGER NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0, event_head TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  match_id TEXT NOT NULL REFERENCES matches(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
  event_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY(match_id, seq)
);
CREATE TRIGGER IF NOT EXISTS event_sequence_guard BEFORE INSERT ON events
WHEN NEW.seq != COALESCE((SELECT MAX(seq)+1 FROM events WHERE match_id=NEW.match_id),1)
OR NEW.prev_hash != COALESCE((SELECT hash FROM events WHERE match_id=NEW.match_id ORDER BY seq DESC LIMIT 1),
'0000000000000000000000000000000000000000000000000000000000000000')
BEGIN SELECT RAISE(ABORT, 'event_sequence_conflict'); END;
CREATE TABLE IF NOT EXISTS round_requests (
  match_id TEXT NOT NULL REFERENCES matches(id), request_id TEXT NOT NULL, revision INTEGER NOT NULL,
  action INTEGER, response_json TEXT NOT NULL, PRIMARY KEY(match_id, request_id), UNIQUE(match_id, revision)
);
CREATE TABLE IF NOT EXISTS results (
  match_id TEXT PRIMARY KEY REFERENCES matches(id), user_id TEXT NOT NULL REFERENCES users(id),
  partition_key TEXT NOT NULL, guild_id TEXT, channel_id TEXT,
  human_score INTEGER NOT NULL, jev_score INTEGER NOT NULL, max_tile INTEGER NOT NULL,
  moves INTEGER NOT NULL, outcome TEXT NOT NULL, replay_hash TEXT NOT NULL, finished_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS telemetry (
  id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES matches(id), received_at INTEGER NOT NULL,
  type TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS results_world ON results(partition_key,human_score DESC,finished_at,match_id);
CREATE INDEX IF NOT EXISTS results_guild ON results(partition_key,guild_id,human_score DESC,finished_at,match_id);
CREATE INDEX IF NOT EXISTS results_channel ON results(partition_key,guild_id,channel_id,human_score DESC,finished_at,match_id);
CREATE INDEX IF NOT EXISTS results_history ON results(user_id,finished_at DESC);
CREATE INDEX IF NOT EXISTS matches_owner ON matches(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS matches_session ON matches(session_id,created_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_match ON telemetry(match_id,received_at);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS proofs_expiry ON proofs(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session ON matches(session_id) WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_user ON matches(user_id) WHERE status='active' AND user_id IS NOT NULL;
