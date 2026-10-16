-- 002: make the audit log append-only (PRD A3: "Entries cannot be edited or deleted by
-- anyone, including admins").
--
-- The app's database user has no TRIGGER, DROP or ALTER privilege (see
-- deploy/mariadb/setup.sql), so it cannot remove these triggers.
-- If binary logging is on, the migration user needs SUPER or
-- log_bin_trust_function_creators=1 to create triggers.

CREATE TRIGGER audit_log_block_update BEFORE UPDATE ON audit_log
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: updates are not allowed';

CREATE TRIGGER audit_log_block_delete BEFORE DELETE ON audit_log
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: deletes are not allowed';
