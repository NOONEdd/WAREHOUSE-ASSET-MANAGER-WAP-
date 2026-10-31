import { sql, type Kysely } from 'kysely'

// Review finding S-2 (decision PD-05: erasing a person removes the name everywhere at once). Person create
// and rename store their response — which contains the name — in wam.idempotency_keys for replay, together
// with a fingerprint that is a SHA-256 of the request, i.e. of the name. This migration links such stored
// responses to their person (subject_person_id, set by the server when it stores them) and adds a trigger
// that, in the erasing transaction itself, replaces every linked response with an id-only tombstone and its
// fingerprint with a fixed marker (32 zero bytes, which no SHA-256 of a request produces in practice), so
// neither the name nor a confirmable hash of it survives. A replay of such a key returns the tombstone
// (src/http/idempotency.ts). The trigger function is SECURITY DEFINER so that the server's role needs no
// right to rewrite fingerprints; it can only produce the tombstone, and only for an erasure. The trigger
// fires for every erasure path, the server's and the schema owner's alike.

export const UP = String.raw`ALTER TABLE wam.idempotency_keys ADD COLUMN subject_person_id bigint REFERENCES wam.persons (id);
CREATE INDEX idempotency_keys_subject_person_idx ON wam.idempotency_keys (subject_person_id) WHERE subject_person_id IS NOT NULL;
GRANT UPDATE (subject_person_id) ON wam.idempotency_keys TO wam_app;

CREATE FUNCTION wam.persons_tombstone_idempotency() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE wam.idempotency_keys
     SET response_body = pg_catalog.jsonb_build_object('id', response_body -> 'id', 'displayName', NULL::text,
                                                       'erased', true, 'version', response_body -> 'version'),
         fingerprint = pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex')
   WHERE subject_person_id = NEW.id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION wam.persons_tombstone_idempotency() FROM PUBLIC;
CREATE TRIGGER persons_tombstone_idempotency AFTER UPDATE OF erased_at ON wam.persons
  FOR EACH ROW WHEN (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL)
  EXECUTE FUNCTION wam.persons_tombstone_idempotency();
`

// Guarded reverse, like 0005–0007: locks first, then refuses while any stored response is linked to a person
// (keys live 24 hours), because without the link an erasure could no longer tombstone those responses.
export const DOWN = String.raw`LOCK TABLE wam.idempotency_keys, wam.persons IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wam.idempotency_keys WHERE subject_person_id IS NOT NULL) THEN
    RAISE EXCEPTION 'refusing to revert; stored responses are linked to persons. Wait until they expire (24 hours) or write a forward migration'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

DROP TRIGGER persons_tombstone_idempotency ON wam.persons;
DROP FUNCTION wam.persons_tombstone_idempotency();
REVOKE UPDATE (subject_person_id) ON wam.idempotency_keys FROM wam_app;
DROP INDEX wam.idempotency_keys_subject_person_idx;
ALTER TABLE wam.idempotency_keys DROP COLUMN subject_person_id;
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db)
}
