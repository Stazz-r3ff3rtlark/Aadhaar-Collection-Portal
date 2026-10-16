# Aadhaar Collection Portal

Collects Aadhaar copies for hotel bookings: sales coordinators → hospitality → vendor hotels.
Requirements: [docs/PRD.md](docs/PRD.md). Working rules: [CLAUDE.md](CLAUDE.md).

## Status: M0 (foundation)

Built:

- Repo layout, nginx and pm2 config (API on 127.0.0.1:17101, served same-site under `/api`).
- MariaDB migrations for the core tables, plus an append-only audit log enforced by triggers.
- Internal sign-in: admin-managed @alembic.co.in allow-list, emailed one-time code or password
  (bcrypt, 10+ characters, 15-minute lock after 5 failures, reset by emailed code).
- Role-based access (admin, hospitality, sales coordinator, analytics viewer) with division and
  booking-status rules for coordinators.
- Audit logging on every endpoint, a minimal admin page for the allow-list, and tests.

Not built yet (later stages): bookings, employee and rooming list imports, employee upload links,
file storage and processing, the email queue and reminders, hotel links, retention jobs and analytics.

## Layout

```
backend/              Node.js API (Express, CommonJS)
  src/app.js          Express app (no listen); src/server.js starts it
  src/http/route.js   defineRoute(): auth + permission + audit for every endpoint
  src/auth/           sign-in service, routes, access policy
  src/audit/          audit service and admin audit-log endpoint
  src/admin/          allow-list (users) management
  src/db/             MariaDB store, in-memory test store, migration runner
  migrations/         numbered SQL migrations (forward-only)
  storage/            private files (git-ignored, mode 700, never served by nginx)
  ecosystem.config.js pm2
frontend/             React (Vite); calls the API at the relative path /api
deploy/nginx/         site config
deploy/mariadb/       database and user setup
```

## Local development

Needs Node 22 or newer and a MariaDB 10.6+ server.

```sh
# Database (once): edit the passwords in the file first
mariadb -u root -p < deploy/mariadb/setup.sql

# Backend
cd backend
npm install
cp .env.example .env     # set NODE_ENV=development, DB_*, and MAIL_TRANSPORT=file
npm run migrate
npm run create-admin -- --email you@alembic.co.in --name "Your Name"
npm run dev              # http://127.0.0.1:17101

# Frontend (second terminal)
cd frontend
npm install
npm run dev              # http://localhost:5173, proxies /api to the backend
```

With `MAIL_TRANSPORT=file`, sign-in emails are written to `backend/storage/dev-mail/*.eml`
instead of being sent.

## Tests

```sh
cd backend && npm test     # sign-in, access rules, audit logging (68 tests)
cd frontend && npm test    # date formatting
```

Backend tests use an in-memory store by default. To run the same tests against a real MariaDB,
point them at a dedicated, disposable test database:

```sh
TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=aadhaar_portal_test npm test
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
