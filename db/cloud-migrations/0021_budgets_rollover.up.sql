-- Budget rollover (cloud/SQLite mirror of Postgres migration 0021).
ALTER TABLE budgets ADD COLUMN rollover integer NOT NULL DEFAULT 0;
