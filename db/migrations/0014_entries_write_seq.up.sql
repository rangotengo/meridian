-- Deterministic same-day valuation ordering. Balances pick the winning
-- valuation for a date by (date, created_at): the latest write wins.
-- created_at alone cannot always settle that — two writes can share a
-- timestamp, and the column default (now()) is the transaction start
-- time rather than the write time. Valuation writers now stamp
-- created_at explicitly at statement-execution time (clock_timestamp()),
-- and this sequence-backed write_seq is the final tiebreaker: sequence
-- values are allocated when each INSERT executes, so under the
-- per-account writer lock they always reflect true insertion order.
-- Existing rows are numbered by the volatile default in heap order,
-- which for this append-mostly table matches their insertion order;
-- ordering between rows with distinct created_at values is unchanged.
-- (The cloud backend has no such column: the balance engine tie-breaks
-- by SQLite's rowid there, which is likewise insertion order.)
CREATE SEQUENCE entries_write_seq;

ALTER TABLE entries
  ADD COLUMN write_seq bigint NOT NULL DEFAULT nextval('entries_write_seq');

ALTER SEQUENCE entries_write_seq OWNED BY entries.write_seq;
