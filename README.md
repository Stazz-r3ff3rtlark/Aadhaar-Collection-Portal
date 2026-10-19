# Aadhaar Collection Portal

Collects Aadhaar copies for hotel bookings: sales coordinators → hospitality → vendor hotels.
Requirements: [docs/PRD.md](docs/PRD.md). Working rules: [CLAUDE.md](CLAUDE.md).

## Status: M1 (divisions, users, bookings)

**M0, foundation:**

- Repo layout, nginx and pm2 config (API on 127.0.0.1:17101, served same-site under `/api`).
- MariaDB migrations for the core tables, plus an append-only audit log enforced by triggers.
- Internal sign-in: admin-managed @alembic.co.in allow-list, emailed one-time code or password
  (bcrypt, 10+ characters, 15-minute lock after 5 failures, reset by emailed code).
- Role-based access and audit logging on every endpoint.

**M1:**

- Divisions: add, rename, archive, restore; delete only when no users or bookings use it.
- Users: every user has one division (only coordinators are limited by it). Edit name, email,
  role and division; deactivate, reactivate; delete only accounts that never acted. Any change
  signs the user out at once. Nobody can remove the last active admin, or deactivate, demote or
  delete themselves.
- Sign-in shows one neutral message for every email, so it never reveals whether an account exists.
- Hotels: coordinators pick one or type a new name (saved as pending); admin or hospitality
  complete pending hotels or merge duplicates.
- Bookings: create and edit (hotel, DD/MM/YYYY travel period, event, location). Deadline is 23:59
  IST on check-in minus 7 days; bookings made fewer than 7 days ahead are flagged short notice.
  Coordinators share their division's bookings; hospitality and admins see all (admins read-only).
  Each booking records who created it and who last changed it.
- Status model: Draft, Collecting, Finalised, With hospitality, Shared with hotel, Completed,
  Files deleted, Cancelled. Available now: start collecting, cancel (with a note), restore and
  reopen. Finalise, hand-over, sharing, completion and file deletion are defined but wait for
  their later stages; the page explains why.
- Employee list: xlsx and csv templates, import with a preview (row errors and counts; nothing saved
  until confirmed), replace or add to the list, and add, replace or remove one person. Vacant rows:
  coordinators flip them until finalise, hospitality at any time. Vacant rows are excluded from
  active and pending counts and from the active traveller list.

Not built yet (later stages): the finalise checklist, rooming list, employee upload links, file
storage and processing, the email queue and reminders, deadline extensions (including setting a
short-notice deadline), hotel links, retention jobs and analytics.

## Layout

```
backend/              Node.js API (Express, CommonJS)
  src/app.js          Express app (no listen); src/server.js starts it
  src/http/route.js   defineRoute(): auth + permission + audit for every endpoint
  src/auth/           sign-in service, routes, access policy
  src/audit/          audit service and admin audit-log endpoint
  src/admin/          users (allow-list) and divisions
  src/hotels/         hotel list, pending hotels, merge
  src/bookings/       bookings, status model, deadline, employee list import
  src/db/             MariaDB store and migration runner
  migrations/         numbered SQL migrations (forward-only)
  storage/            private files (git-ignored, mode 700, never served by nginx)
  ecosystem.config.js pm2
frontend/             React (Vite); calls the API at the relative path /api
deploy/nginx/         site config
deploy/mariadb/       database and user setup
```

## Local development

Needs Node 22 or newer and a MariaDB 10.4+ server.

```sh
# Database (once): edit the passwords in the file first
mariadb -u root -p < deploy/mariadb/setup.sql

# Backend
cd backend
npm install
cp .env.example .env     # set NODE_ENV=development, DB_*, and MAIL_TRANSPORT=file
npm run migrate
npm run create-admin -- --email you@alembic.co.in --name "Your Name" --division "Digilabs"
npm run dev              # http://127.0.0.1:17101

# Frontend (second terminal)
cd frontend
npm install
npm run dev              # http://localhost:5173, proxies /api to the backend
```

With `MAIL_TRANSPORT=file`, sign-in emails are written to `backend/storage/dev-mail/*.eml`
instead of being sent.

## Database migrations

Migrations live in `backend/migrations/` and run in number order. Each runs once, and the runner
refuses one that was edited after it was applied. Apply any new ones with:

```sh
cd backend
npm run migrate
```

It uses the database in `backend/.env` (`DB_MIGRATION_USER` / `DB_MIGRATION_PASSWORD` if set,
otherwise `DB_USER` / `DB_PASSWORD`). Restart the API afterwards.

## Tests

Backend tests run against a real MariaDB **test** database, by default `aadhaar_portal_test` on the
server in `backend/.env`. Every table in it is emptied before each test, so the harness refuses any
database whose name does not end in `_test`. Create it once:

```sql
CREATE DATABASE aadhaar_portal_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

The test user needs full rights on that database (it migrates it and empties tables). To use a
different server or user, set `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD`
and `TEST_DB_NAME`.

```sh
cd backend && npm test     # sign-in, access, audit, admin, bookings, employee list
cd frontend && npm test    # date formatting
```

## Production deploy

```sh
# Backend
cd backend && npm ci --omit=dev
cp .env.example .env && chmod 600 .env    # fill in every value
npm run migrate
pm2 start ecosystem.config.js && pm2 save
pm2 install pm2-logrotate

# Frontend
cd frontend && npm ci && npm run build
rsync -a --delete dist/ /var/www/aadhaar-portal/frontend/

# nginx
cp deploy/nginx/aadhaar-portal.conf /etc/nginx/conf.d/
nginx -t && systemctl reload nginx
```

Later releases: `npm run migrate`, then `pm2 reload aadhaar-portal-api`.

## Conventions

- **Times**: IST throughout. DB `DATETIME(3)` columns hold IST wall-clock time; every connection
  runs `SET time_zone = '+05:30'`. Use `src/lib/time.js`, never the server timezone.
  Show dates as DD/MM/YYYY.
- **New endpoints** go through `defineRoute()`, which refuses to register a route without an
  audit action and writes the audit entry in the same transaction as the change.
- **Logging**: `src/lib/logger.js` only. Log IDs, statuses and counts. Never log request bodies,
  file data, codes or tokens.
