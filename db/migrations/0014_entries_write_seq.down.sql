-- Dropping the column also drops the sequence it owns (OWNED BY).
ALTER TABLE entries DROP COLUMN IF EXISTS write_seq;
DROP SEQUENCE IF EXISTS entries_write_seq;
