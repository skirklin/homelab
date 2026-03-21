CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);

CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    institution   TEXT,
    external_id   TEXT,
    profile       TEXT,
    account_type  TEXT NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'USD',
    is_liability  INTEGER NOT NULL DEFAULT 0,
    metadata      TEXT DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(institution, external_id)
);

CREATE TABLE IF NOT EXISTS balances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    as_of         TEXT NOT NULL,
    balance       REAL NOT NULL,
    source        TEXT NOT NULL,
    raw_file_ref  TEXT,
    recorded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, as_of, source)
);

CREATE INDEX IF NOT EXISTS idx_balances_as_of ON balances(as_of);
CREATE INDEX IF NOT EXISTS idx_balances_account_date ON balances(account_id, as_of);

CREATE TABLE IF NOT EXISTS transactions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id       TEXT NOT NULL REFERENCES accounts(id),
    date             TEXT NOT NULL,
    amount           REAL NOT NULL,
    description      TEXT,
    category         TEXT,
    display_category TEXT,
    raw_file_ref     TEXT,
    recorded_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, date, amount, description)
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);

CREATE TABLE IF NOT EXISTS performance_history (
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    date          TEXT NOT NULL,
    balance       REAL NOT NULL,
    invested      REAL,
    earned        REAL,
    PRIMARY KEY (account_id, date)
);

CREATE INDEX IF NOT EXISTS idx_perf_date ON performance_history(date);

CREATE TABLE IF NOT EXISTS option_grants (
    id                TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES accounts(id),
    grant_date        TEXT NOT NULL,
    grant_type        TEXT NOT NULL DEFAULT 'NQ',
    total_shares      INTEGER NOT NULL,
    vested_shares     INTEGER NOT NULL DEFAULT 0,
    strike_price      REAL NOT NULL,
    vested_value      REAL NOT NULL DEFAULT 0,
    expiration_date   TEXT,
    vest_dates        TEXT
);

CREATE TABLE IF NOT EXISTS private_valuations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    as_of         TEXT NOT NULL,
    fmv_per_share REAL NOT NULL,
    source        TEXT,
    recorded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, as_of)
);

CREATE TABLE IF NOT EXISTS holdings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    as_of         TEXT NOT NULL,
    symbol        TEXT,
    name          TEXT NOT NULL,
    asset_class   TEXT,
    shares        REAL NOT NULL,
    value         REAL NOT NULL,
    source        TEXT NOT NULL,
    raw_file_ref  TEXT,
    recorded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, as_of, symbol, source)
);

CREATE INDEX IF NOT EXISTS idx_holdings_account_date ON holdings(account_id, as_of);
CREATE INDEX IF NOT EXISTS idx_holdings_symbol ON holdings(symbol);

CREATE TABLE IF NOT EXISTS ingestion_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    profile       TEXT,
    status        TEXT NOT NULL,
    raw_file_ref  TEXT,
    error_message TEXT,
    started_at    TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    tag            TEXT NOT NULL,
    source         TEXT NOT NULL DEFAULT 'rule',
    PRIMARY KEY (transaction_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_txn_tags_tag ON transaction_tags(tag);
