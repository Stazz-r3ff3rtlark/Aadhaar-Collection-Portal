-- 005 (M2): the employee page. One shared link per booking, employee identification by
-- an emailed code, and an employee session for uploading.
--
-- Safe to run again: every statement uses IF EXISTS / IF NOT EXISTS.

-- The booking link token is derived from a server secret, the booking id and this
-- version (see src/employees/booking-link.js), so it can be shown again to the
-- coordinator without storing it. Raising the version replaces the link.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS share_token_version SMALLINT UNSIGNED NOT NULL DEFAULT 1
      COMMENT 'raise to replace the shared booking link' AFTER share_token_hash;

-- Emailed codes for employees confirming who they are. Same rules as staff sign-in
-- codes (10 minutes, 5 tries, once a minute, five an hour). Only an HMAC is stored.
CREATE TABLE IF NOT EXISTS employee_otp_codes (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_employee_id  INT UNSIGNED NOT NULL,
  code_hash            CHAR(64)     NOT NULL,
  attempts             TINYINT UNSIGNED NOT NULL DEFAULT 0,
  request_ip           VARCHAR(45)  NULL,
  created_at           DATETIME(3)  NOT NULL COMMENT 'IST',
  expires_at           DATETIME(3)  NOT NULL COMMENT 'IST',
  consumed_at          DATETIME(3)  NULL     COMMENT 'IST',
  invalidated_at       DATETIME(3)  NULL     COMMENT 'IST; superseded or too many attempts',
  PRIMARY KEY (id),
  KEY ix_employee_otp_employee (booking_employee_id, created_at),
  KEY ix_employee_otp_ip (request_ip, created_at),
  CONSTRAINT fk_employee_otp_employee FOREIGN KEY (booking_employee_id) REFERENCES booking_employees (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Short sessions for an identified employee on one booking. The cookie carries a random
-- token; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS employee_sessions (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash           CHAR(64)     NOT NULL,
  booking_employee_id  INT UNSIGNED NOT NULL,
  ip                   VARCHAR(45)  NULL,
  user_agent           VARCHAR(255) NULL,
  created_at           DATETIME(3)  NOT NULL COMMENT 'IST',
  last_seen_at         DATETIME(3)  NOT NULL COMMENT 'IST',
  expires_at           DATETIME(3)  NOT NULL COMMENT 'IST; absolute expiry',
  revoked_at           DATETIME(3)  NULL     COMMENT 'IST',
  PRIMARY KEY (id),
  UNIQUE KEY uq_employee_sessions_token (token_hash),
  KEY ix_employee_sessions_employee (booking_employee_id, revoked_at),
  CONSTRAINT fk_employee_sessions_employee FOREIGN KEY (booking_employee_id) REFERENCES booking_employees (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Files are stored per booking (storage/aadhaar/<booking id>/), so the deletion job can
-- find every file of a booking from submission_files alone, even if the employee row
-- has changed since.
ALTER TABLE submission_files
  ADD COLUMN IF NOT EXISTS booking_id INT UNSIGNED NULL COMMENT 'denormalised for whole-booking deletion' AFTER submission_id,
  ADD KEY IF NOT EXISTS ix_submission_files_booking (booking_id, deleted_at);

ALTER TABLE submission_files
  ADD CONSTRAINT fk_submission_files_booking FOREIGN KEY IF NOT EXISTS (booking_id) REFERENCES bookings (id);
