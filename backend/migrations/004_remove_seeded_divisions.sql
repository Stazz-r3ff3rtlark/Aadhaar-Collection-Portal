-- 004: divisions are a flat list of free names that admins manage (for example Megacare,
-- Maxis, Business Excellence, Digilabs). The app assumes no particular names.
--
-- Migration 001 seeded "Marketing" and "Business Enablers" as examples, and 003 added
-- "Unassigned" as a holding place for users who had no division. This removes those rows
-- only where they are still exactly as seeded: created by that migration (not later by an
-- admin), never renamed or archived, and with no users and no bookings. Anything in use
-- stays; admins can rename it in the Divisions page. Each removal is written to the audit
-- log. Safe to run again: a second run finds nothing to remove.

CREATE TEMPORARY TABLE seeded_divisions_to_remove AS
SELECT d.id, d.name
  FROM divisions d
 WHERE d.archived_at IS NULL
   AND d.created_at = d.updated_at
   AND (
         (d.name IN ('Marketing', 'Business Enablers')
          AND d.created_at <= (SELECT applied_at FROM schema_migrations WHERE version = '001_core_schema'))
      OR (d.name = 'Unassigned'
          AND d.created_at <= (SELECT applied_at FROM schema_migrations WHERE version = '003_m1_divisions_hotels_bookings'))
       )
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.division_id = d.id)
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.division_id = d.id);

INSERT INTO audit_log (occurred_at, actor_type, actor_label, action, outcome, entity_type, entity_id, details)
SELECT NOW(3), 'system', 'migration 004_remove_seeded_divisions', 'admin.divisions.delete', 'success',
       'division', CAST(id AS CHAR),
       JSON_OBJECT('name', name, 'reason', 'example division seeded by a migration; never used or edited')
  FROM seeded_divisions_to_remove;

DELETE d FROM divisions d JOIN seeded_divisions_to_remove s ON s.id = d.id;

DROP TEMPORARY TABLE seeded_divisions_to_remove;
