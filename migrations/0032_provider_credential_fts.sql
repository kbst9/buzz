-- NIP-PC kind:30990 (agent provider credential) contains credential-bearing
-- NIP-44 ciphertext readable only by the delivering owner and the recipient
-- agent. Exclude it from full-text search without changing the search policy
-- of existing installations, mirroring migration 0014 (kind:30350): capture
-- the current generated expression, then wrap it with the new exclusion so
-- both the fresh-install allowlist and any brownfield/operator-managed
-- expression are preserved for every other kind.
--
-- kind:30991 (credential status) is deliberately NOT excluded — it is a
-- non-secret, member-readable projection.
DO $$
DECLARE
    existing_expression TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO existing_expression
      FROM pg_attrdef d
      JOIN pg_attribute a
        ON a.attrelid = d.adrelid
       AND a.attnum = d.adnum
     WHERE d.adrelid = 'events'::regclass
       AND a.attname = 'search_tsv';

    IF existing_expression IS NULL THEN
        RAISE EXCEPTION 'events.search_tsv generated expression not found';
    END IF;

    ALTER TABLE events DROP COLUMN search_tsv;
    EXECUTE format(
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (CASE WHEN kind = 30990 THEN NULL::tsvector ELSE (%s) END) STORED',
        existing_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;
