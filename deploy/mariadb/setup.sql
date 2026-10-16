-- One-time MariaDB setup for the Aadhaar Collection Portal. Run as root:
--   mariadb -u root -p < deploy/mariadb/setup.sql
-- Replace both passwords first (and put them in backend/.env), then run `npm run migrate`.
--
-- Two users:
--   aadhaar_migrator  owns the schema (DDL, triggers). Used only by `npm run migrate`.
--   aadhaar_app       the running API: read and write rows, nothing else. Without
--                     ALTER, DROP or TRIGGER it cannot remove the audit log's
--                     append-only triggers or truncate the log.

CREATE DATABASE IF NOT EXISTS aadhaar_portal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'aadhaar_migrator'@'localhost' IDENTIFIED BY 'CHANGE-ME-migrator-password';
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER, SELECT, INSERT, UPDATE, DELETE
  ON aadhaar_portal.* TO 'aadhaar_migrator'@'localhost';

CREATE USER IF NOT EXISTS 'aadhaar_app'@'localhost' IDENTIFIED BY 'CHANGE-ME-app-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON aadhaar_portal.* TO 'aadhaar_app'@'localhost';

-- If binary logging is enabled, creating triggers as a non-SUPER user needs:
--   SET GLOBAL log_bin_trust_function_creators = 1;   (and the same in my.cnf)

FLUSH PRIVILEGES;
