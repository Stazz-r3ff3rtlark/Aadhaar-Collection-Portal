-- 003 (M1): every user has a division; hotels can be pending review or merged; bookings
-- record who last changed them and the status before a cancellation.
--
-- MariaDB applies schema changes one statement at a time, so every statement here is
-- safe to run again: if the migration stops halfway, running it again finishes the job.

-- ---------------------------------------------------------------------------
-- Users: exactly one division each, whatever the role.
-- Existing users without one go to a new "Unassigned" division.
-- ---------------------------------------------------------------------------

-- M0 allowed a division only for coordinators. Drop that rule first, or giving the
-- other users a division below would break it.
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_coordinator_division;

INSERT INTO divisions (name, created_at, updated_at)
SELECT 'Unassigned', NOW(3), NOW(3) FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM divisions WHERE name = 'Unassigned');

UPDATE users
   SET division_id = (SELECT id FROM divisions WHERE name = 'Unassigned'),
       updated_at = NOW(3)
 WHERE division_id IS NULL;

ALTER TABLE users
  MODIFY division_id INT UNSIGNED NOT NULL COMMENT 'every user has one; only coordinators are limited by it';

-- ---------------------------------------------------------------------------
-- Hotels: a name typed by a coordinator becomes a pending entry for admin or
-- hospitality to complete, or merge into an existing hotel.
-- ---------------------------------------------------------------------------

ALTER TABLE hotels
  ADD COLUMN IF NOT EXISTS review_status ENUM('pending','active') NOT NULL DEFAULT 'active' AFTER city,
  ADD COLUMN IF NOT EXISTS merged_into_hotel_id INT UNSIGNED NULL AFTER review_status,
  ADD COLUMN IF NOT EXISTS created_by_user_id INT UNSIGNED NULL AFTER archived_at,
  ADD COLUMN IF NOT EXISTS updated_by_user_id INT UNSIGNED NULL AFTER created_by_user_id,
  ADD KEY IF NOT EXISTS ix_hotels_review (review_status, archived_at),
  ADD CONSTRAINT fk_hotels_merged_into FOREIGN KEY IF NOT EXISTS (merged_into_hotel_id) REFERENCES hotels (id),
  ADD CONSTRAINT fk_hotels_created_by FOREIGN KEY IF NOT EXISTS (created_by_user_id) REFERENCES users (id),
  ADD CONSTRAINT fk_hotels_updated_by FOREIGN KEY IF NOT EXISTS (updated_by_user_id) REFERENCES users (id);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS previous_status ENUM('draft','collecting','finalised','with_hospitality','shared_with_hotel',
                                  'completed','files_deleted','cancelled') NULL
      COMMENT 'status before cancellation, used to restore' AFTER status_changed_at,
  ADD COLUMN IF NOT EXISTS updated_by_user_id INT UNSIGNED NULL COMMENT 'who last changed the booking or its employees' AFTER created_by_user_id;

ALTER TABLE bookings
  ADD CONSTRAINT fk_bookings_updated_by FOREIGN KEY IF NOT EXISTS (updated_by_user_id) REFERENCES users (id);

-- Check-out must now be strictly after check-in (M0 allowed the same day).
-- Kept in their own statements: on MariaDB 10.4, adding a CHECK in the same statement as
-- "FOREIGN KEY IF NOT EXISTS" fails when run a second time.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_dates;

ALTER TABLE bookings
  ADD CONSTRAINT chk_bookings_dates CHECK (check_in_date IS NULL OR check_out_date IS NULL OR check_out_date > check_in_date);

UPDATE bookings SET updated_by_user_id = created_by_user_id WHERE updated_by_user_id IS NULL;
