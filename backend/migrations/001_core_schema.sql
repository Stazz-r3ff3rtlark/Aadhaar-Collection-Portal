-- 001: core tables (PRD v1.0, "Technical design" and "Core records").
--
-- Time convention: every DATETIME column holds IST (Asia/Kolkata, +05:30) wall-clock
-- time. The app and the migration runner both set the session time_zone to '+05:30'
-- explicitly, so NOW() and stored values agree regardless of the server default.
-- DATE columns are IST calendar dates.
--
-- No Aadhaar number is stored anywhere (PRD, Privacy: "No Aadhaar number in the
-- database in P1"). Files are referenced only by an opaque storage key.

-- ---------------------------------------------------------------------------
-- Master data
-- ---------------------------------------------------------------------------

CREATE TABLE divisions (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL,
  archived_at   DATETIME(3)  NULL     COMMENT 'IST',
  created_at    DATETIME(3)  NOT NULL COMMENT 'IST',
  updated_at    DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  UNIQUE KEY uq_divisions_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO divisions (name, created_at, updated_at) VALUES
  ('Marketing', NOW(3), NOW(3)),
  ('Business Enablers', NOW(3), NOW(3));

CREATE TABLE hotels (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(200) NOT NULL,
  city              VARCHAR(100) NULL,
  default_contacts  JSON         NULL COMMENT 'list of {name, phone, email}',
  archived_at       DATETIME(3)  NULL     COMMENT 'IST',
  created_at        DATETIME(3)  NOT NULL COMMENT 'IST',
  updated_at        DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  KEY ix_hotels_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Internal users and sign-in
-- ---------------------------------------------------------------------------

-- The allow-list. A row here (added by an admin) is the only way to sign in.
-- Users are deactivated, never deleted, so audit history keeps its author.
CREATE TABLE users (
  id                        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email                     VARCHAR(254) NOT NULL COMMENT 'lower-case, @alembic.co.in only',
  name                      VARCHAR(150) NOT NULL,
  role                      ENUM('admin','hospitality','coordinator','analytics_viewer') NOT NULL,
  division_id               INT UNSIGNED NULL COMMENT 'required for coordinators, empty otherwise',
  password_hash             VARCHAR(100) NULL COMMENT 'bcrypt; NULL until the user sets a password',
  password_set_at           DATETIME(3)  NULL COMMENT 'IST',
  failed_password_attempts  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until              DATETIME(3)  NULL COMMENT 'IST; password sign-in locked until then',
  is_active                 TINYINT(1)   NOT NULL DEFAULT 1,
  deactivated_at            DATETIME(3)  NULL COMMENT 'IST',
  last_login_at             DATETIME(3)  NULL COMMENT 'IST',
  created_by_user_id        INT UNSIGNED NULL,
  created_at                DATETIME(3)  NOT NULL COMMENT 'IST',
  updated_at                DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_role (role, is_active),
  CONSTRAINT fk_users_division FOREIGN KEY (division_id) REFERENCES divisions (id),
  CONSTRAINT fk_users_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_users_email_domain CHECK (email LIKE '%@alembic.co.in'),
  CONSTRAINT chk_users_coordinator_division CHECK ((role = 'coordinator') = (division_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Server-side sessions. The cookie carries a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash      CHAR(64)     NOT NULL,
  user_id         INT UNSIGNED NOT NULL,
  auth_method     ENUM('otp','password') NOT NULL,
  ip              VARCHAR(45)  NULL,
  user_agent      VARCHAR(255) NULL,
  created_at      DATETIME(3)  NOT NULL COMMENT 'IST',
  last_seen_at    DATETIME(3)  NOT NULL COMMENT 'IST',
  expires_at      DATETIME(3)  NOT NULL COMMENT 'IST; absolute expiry',
  revoked_at      DATETIME(3)  NULL     COMMENT 'IST',
  revoked_reason  VARCHAR(40)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY ix_sessions_user (user_id, revoked_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Emailed one-time codes for internal sign-in and password reset. Only an HMAC is stored.
CREATE TABLE otp_codes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  purpose         ENUM('login','password_reset') NOT NULL,
  code_hash       CHAR(64)     NOT NULL,
  attempts        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  request_ip      VARCHAR(45)  NULL,
  created_at      DATETIME(3)  NOT NULL COMMENT 'IST',
  expires_at      DATETIME(3)  NOT NULL COMMENT 'IST',
  consumed_at     DATETIME(3)  NULL     COMMENT 'IST',
  invalidated_at  DATETIME(3)  NULL     COMMENT 'IST; superseded or too many attempts',
  PRIMARY KEY (id),
  KEY ix_otp_user_purpose (user_id, purpose, created_at),
  CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

CREATE TABLE bookings (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  division_id           INT UNSIGNED NOT NULL,
  coordinator_user_id   INT UNSIGNED NOT NULL,
  hotel_id              INT UNSIGNED NULL,
  hotel_name            VARCHAR(200) NULL COMMENT 'as entered on the booking',
  event_name            VARCHAR(200) NULL,
  location              VARCHAR(200) NULL,
  check_in_date         DATE         NULL COMMENT 'IST calendar date',
  check_out_date        DATE         NULL COMMENT 'IST calendar date',
  deadline_at           DATETIME(3)  NULL COMMENT 'IST; default 23:59 on check-in minus 7 days',
  is_short_notice       TINYINT(1)   NOT NULL DEFAULT 0,
  status                ENUM('draft','collecting','finalised','with_hospitality','shared_with_hotel',
                             'completed','files_deleted','cancelled') NOT NULL DEFAULT 'draft',
  status_changed_at     DATETIME(3)  NOT NULL COMMENT 'IST',
  share_token_hash      CHAR(64)     NULL COMMENT 'SHA-256 of the shared booking link token',
  finalised_at          DATETIME(3)  NULL COMMENT 'IST',
  finalised_by_user_id  INT UNSIGNED NULL,
  cancelled_at          DATETIME(3)  NULL COMMENT 'IST',
  cancelled_by_user_id  INT UNSIGNED NULL,
  cancellation_note     VARCHAR(500) NULL,
  files_deleted_at      DATETIME(3)  NULL COMMENT 'IST',
  created_by_user_id    INT UNSIGNED NOT NULL,
  created_at            DATETIME(3)  NOT NULL COMMENT 'IST',
  updated_at            DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  UNIQUE KEY uq_bookings_share_token (share_token_hash),
  KEY ix_bookings_division_status (division_id, status),
  KEY ix_bookings_status_checkin (status, check_in_date),
  KEY ix_bookings_checkout (check_out_date),
  CONSTRAINT fk_bookings_division FOREIGN KEY (division_id) REFERENCES divisions (id),
  CONSTRAINT fk_bookings_coordinator FOREIGN KEY (coordinator_user_id) REFERENCES users (id),
  CONSTRAINT fk_bookings_hotel FOREIGN KEY (hotel_id) REFERENCES hotels (id),
  CONSTRAINT fk_bookings_finalised_by FOREIGN KEY (finalised_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_bookings_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_bookings_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_bookings_dates CHECK (check_in_date IS NULL OR check_out_date IS NULL OR check_out_date >= check_in_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Travellers on a booking, from the uploaded employee list. Vacant rows are kept as
-- headcount but excluded from every process (invites, reminders, counts, rooming, hotel).
CREATE TABLE booking_employees (
  id                            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id                    INT UNSIGNED NOT NULL,
  employee_code                 VARCHAR(50)  NULL,
  name                          VARCHAR(150) NULL,
  email                         VARCHAR(254) NULL,
  mobile                        VARCHAR(20)  NULL,
  department                    VARCHAR(100) NULL,
  zone                          VARCHAR(100) NULL,
  hq                            VARCHAR(100) NULL,
  is_vacant                     TINYINT(1)   NOT NULL DEFAULT 0,
  invite_status                 ENUM('not_sent','sent','opened') NOT NULL DEFAULT 'not_sent',
  invite_sent_at                DATETIME(3)  NULL COMMENT 'IST',
  invite_sent_via               ENUM('email','whatsapp_manual') NULL,
  opened_at                     DATETIME(3)  NULL COMMENT 'IST',
  personal_token_hash           CHAR(64)     NULL COMMENT 'SHA-256 of the personal email link token',
  submission_status             ENUM('pending','submitted') NOT NULL DEFAULT 'pending',
  submitted_at                  DATETIME(3)  NULL COMMENT 'IST',
  deadline_override_at          DATETIME(3)  NULL COMMENT 'IST; per-employee extension',
  verified_at                   DATETIME(3)  NULL COMMENT 'IST; survives file deletion',
  verified_by_type              ENUM('hotel','hospitality') NULL,
  verified_by_user_id           INT UNSIGNED NULL,
  cancelled_at                  DATETIME(3)  NULL COMMENT 'IST',
  cancelled_by_user_id          INT UNSIGNED NULL,
  cancellation_note             VARCHAR(500) NULL,
  cancellation_communicated_at  DATETIME(3)  NULL COMMENT 'IST',
  created_at                    DATETIME(3)  NOT NULL COMMENT 'IST',
  updated_at                    DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  UNIQUE KEY uq_booking_employees_code (booking_id, employee_code),
  UNIQUE KEY uq_booking_employees_token (personal_token_hash),
  KEY ix_booking_employees_status (booking_id, is_vacant, submission_status),
  CONSTRAINT fk_booking_employees_booking FOREIGN KEY (booking_id) REFERENCES bookings (id),
  CONSTRAINT fk_booking_employees_verified_by FOREIGN KEY (verified_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_booking_employees_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES users (id),
  -- B2: email (and a name) are required on every non-vacant row because the OTP is emailed.
  CONSTRAINT chk_booking_employees_contact CHECK (is_vacant = 1 OR (email IS NOT NULL AND name IS NOT NULL AND employee_code IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Submissions and files (file content lives in private storage, never in the DB)
-- ---------------------------------------------------------------------------

CREATE TABLE submissions (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_employee_id       INT UNSIGNED NOT NULL,
  id_type                   VARCHAR(30)  NOT NULL DEFAULT 'aadhaar' COMMENT 'configurable; Aadhaar only in P1',
  card_type                 ENUM('pvc','old_vertical') NOT NULL,
  consent_at                DATETIME(3)  NOT NULL COMMENT 'IST',
  consent_version           VARCHAR(20)  NOT NULL,
  submitted_at              DATETIME(3)  NULL COMMENT 'IST; set once all required sides are uploaded',
  superseded_at             DATETIME(3)  NULL COMMENT 'IST; replaced by a newer submission',
  files_deleted_at          DATETIME(3)  NULL COMMENT 'IST',
  files_deleted_reason      ENUM('retention','manual','cancellation') NULL,
  files_deleted_by_user_id  INT UNSIGNED NULL COMMENT 'NULL when deleted by the retention job',
  created_at                DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  KEY ix_submissions_employee (booking_employee_id, superseded_at),
  CONSTRAINT fk_submissions_employee FOREIGN KEY (booking_employee_id) REFERENCES booking_employees (id),
  CONSTRAINT fk_submissions_deleted_by FOREIGN KEY (files_deleted_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE submission_files (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  submission_id  BIGINT UNSIGNED NOT NULL,
  side           ENUM('front','back','document') NOT NULL,
  storage_key    CHAR(64)     NOT NULL COMMENT 'random opaque key; the path is derived server-side and never exposed',
  mime_type      VARCHAR(50)  NOT NULL,
  size_bytes     INT UNSIGNED NOT NULL,
  page_count     TINYINT UNSIGNED NULL COMMENT 'PDFs only',
  created_at     DATETIME(3)  NOT NULL COMMENT 'IST',
  deleted_at     DATETIME(3)  NULL     COMMENT 'IST; file hard-deleted from storage',
  PRIMARY KEY (id),
  UNIQUE KEY uq_submission_files_key (storage_key),
  KEY ix_submission_files_submission (submission_id),
  CONSTRAINT fk_submission_files_submission FOREIGN KEY (submission_id) REFERENCES submissions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Rooming lists, contacts, hotel links
-- ---------------------------------------------------------------------------

-- Each upload is a new version; old versions stay in history.
CREATE TABLE rooming_list_versions (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id           INT UNSIGNED NOT NULL,
  version              SMALLINT UNSIGNED NOT NULL,
  original_filename    VARCHAR(255) NULL,
  columns_json         JSON         NOT NULL COMMENT 'column headers as uploaded',
  rows_json            JSON         NOT NULL COMMENT 'rows as uploaded (no Aadhaar data)',
  warnings_json        JSON         NULL,
  uploaded_by_user_id  INT UNSIGNED NOT NULL,
  uploaded_at          DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  UNIQUE KEY uq_rooming_list_version (booking_id, version),
  CONSTRAINT fk_rooming_list_booking FOREIGN KEY (booking_id) REFERENCES bookings (id),
  CONSTRAINT fk_rooming_list_uploaded_by FOREIGN KEY (uploaded_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE emergency_contacts (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id          INT UNSIGNED NOT NULL,
  name                VARCHAR(150) NOT NULL,
  phone               VARCHAR(20)  NOT NULL,
  created_by_user_id  INT UNSIGNED NOT NULL,
  created_at          DATETIME(3)  NOT NULL COMMENT 'IST',
  updated_at          DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  KEY ix_emergency_contacts_booking (booking_id),
  CONSTRAINT fk_emergency_contacts_booking FOREIGN KEY (booking_id) REFERENCES bookings (id),
  CONSTRAINT fk_emergency_contacts_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Hotel access: unguessable link + passcode, valid until check-out, revocable.
CREATE TABLE hotel_links (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id          INT UNSIGNED NOT NULL,
  token_hash          CHAR(64)     NOT NULL,
  passcode_hash       VARCHAR(100) NOT NULL,
  expires_at          DATETIME(3)  NOT NULL COMMENT 'IST; end of check-out date',
  failed_attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until        DATETIME(3)  NULL COMMENT 'IST',
  first_viewed_at     DATETIME(3)  NULL COMMENT 'IST',
  revoked_at          DATETIME(3)  NULL COMMENT 'IST',
  revoked_by_user_id  INT UNSIGNED NULL,
  created_by_user_id  INT UNSIGNED NOT NULL,
  created_at          DATETIME(3)  NOT NULL COMMENT 'IST',
  PRIMARY KEY (id),
  UNIQUE KEY uq_hotel_links_token (token_hash),
  KEY ix_hotel_links_booking (booking_id, revoked_at),
  CONSTRAINT fk_hotel_links_booking FOREIGN KEY (booking_id) REFERENCES bookings (id),
  CONSTRAINT fk_hotel_links_revoked_by FOREIGN KEY (revoked_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_hotel_links_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Audit log (append-only; see 002)
-- ---------------------------------------------------------------------------

-- No foreign keys on purpose: the log must outlive and stay independent of the rows it
-- describes. It never holds Aadhaar images, numbers or file content.
CREATE TABLE audit_log (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurred_at    DATETIME(3)  NOT NULL COMMENT 'IST',
  actor_type     ENUM('user','employee','hotel','system','anonymous') NOT NULL,
  actor_user_id  INT UNSIGNED NULL,
  actor_email    VARCHAR(254) NULL COMMENT 'snapshot at the time of the action',
  actor_role     VARCHAR(30)  NULL,
  actor_label    VARCHAR(200) NULL COMMENT 'employee or hotel name, or system job name',
  action         VARCHAR(80)  NOT NULL,
  outcome        ENUM('success','failure','denied') NOT NULL,
  entity_type    VARCHAR(40)  NULL,
  entity_id      VARCHAR(64)  NULL,
  booking_id     INT UNSIGNED NULL,
  ip             VARCHAR(45)  NULL,
  user_agent     VARCHAR(255) NULL,
  request_id     CHAR(36)     NULL,
  details        JSON         NULL COMMENT 'sanitised; old and new values where relevant',
  PRIMARY KEY (id),
  KEY ix_audit_occurred (occurred_at),
  KEY ix_audit_booking (booking_id, occurred_at),
  KEY ix_audit_actor (actor_user_id, occurred_at),
  KEY ix_audit_action (action, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
