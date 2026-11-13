-- 目标租约 / 运行账本 / 幂等键
-- D1 (SQLite)。全部为新增表，不改现有表结构，回滚只需 DROP 这三张表。

CREATE TABLE IF NOT EXISTS collection_leases (
  target_id   TEXT PRIMARY KEY,          -- `${sourceId}::${encodeURIComponent(url)}`
  owner       TEXT NOT NULL,             -- runId 或执行者标识
  acquired_at TEXT NOT NULL,             -- ISO8601
  heartbeat_at TEXT NOT NULL,
  expires_at  INTEGER NOT NULL           -- epoch ms，便于直接比较
);

CREATE INDEX IF NOT EXISTS idx_collection_leases_expires
  ON collection_leases (expires_at);

CREATE TABLE IF NOT EXISTS run_ledger (
  run_id      TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  edition     INTEGER NOT NULL DEFAULT 0, -- 1 = 10:00 出刊轮
  status      TEXT NOT NULL,              -- running | ok | partial | failed
  planned     INTEGER NOT NULL DEFAULT 0,
  success     INTEGER NOT NULL DEFAULT 0,
  blocked     INTEGER NOT NULL DEFAULT 0,
  new_posts   INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_ledger_started
  ON run_ledger (started_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,              -- collection | broadcast | ingest
  run_id      TEXT,
  created_at  TEXT NOT NULL,
  response    TEXT                        -- 首次响应体，回放时原样返回
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created
  ON idempotency_keys (created_at);
