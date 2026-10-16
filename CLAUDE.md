# CLAUDE.md: Aadhaar Collection Portal

Portal that streamlines collection and relay of Aadhaar cards from sales to sales coordinators to hospitality to vendor hotels. Full requirements: PRD v1.0 (signed off 14/10/2026), https://claude.ai/code/artifact/094220e9-bc43-42e3-949b-46bcc08df43e

## Stack

- Frontend: React
- Backend: Node.js
- Database: MariaDB
- Web server: nginx (reverse proxy and static frontend)
- Process manager: pm2
- App port: 17101 (backend listens here; nginx proxies to it)

## Routing

- The frontend and API are served **same-site**. The frontend always calls the API at the relative path `/api` (for example `fetch('/api/bookings')`). Never hardcode a host or port in frontend code.
- nginx forwards `/api` to the Node.js backend on port 17101 and serves the built React app for everything else.
- Because it is same-site, avoid CORS workarounds; cookies and sessions rely on this.

## Commands

Standard npm scripts, run in each package (frontend and backend):

- `npm install`: install dependencies
- `npm run dev`: local development
- `npm run build`: production build
- `npm test`: run tests
- Production: backend runs under pm2 via `ecosystem.config.js` (for example `pm2 start ecosystem.config.js`, `pm2 reload <app-name>`, `pm2 logs <app-name>`).

## Dates and times

- Display dates as **DD/MM/YYYY** everywhere in the UI, emails, exports and logs shown to users.
- All times are **IST (Asia/Kolkata, UTC+5:30)**. Show, schedule and compare in IST. Make the timezone explicit in code (do not rely on server default) and in MariaDB columns and queries.
- Examples of IST-bound rules: booking deadline is check-in date minus 7 days at 23:59 IST; Aadhaar files are deleted at 02:00 IST the day after check-out.

## Non-negotiable rules

1. **Never log Aadhaar content.** No Aadhaar numbers, images, file contents, OCR text or base64 in application logs, pm2 logs, nginx logs, error reports, console output, test fixtures or analytics. Log only IDs, statuses and counts.
2. **Never expose file URLs publicly.** Uploaded Aadhaar files live in a private storage folder inside the backend directory, outside anything nginx serves directly. They are streamed only through authenticated, authorised `/api` endpoints (or time-limited, scoped access for hotels). No static paths, no guessable URLs, no public links.
3. **Every action writes to the audit log.** Any create, read of Aadhaar or personal data, update, delete, extension, reopen, cancellation, login, OTP, download, hotel access and admin change must write an audit entry (who, what, which booking or record, when in IST). New endpoints are not done until they write to the audit log.

## Code conventions (from M0)

- Layout: `backend/` (Express, CommonJS), `frontend/` (React + Vite), `deploy/` (nginx, MariaDB setup). See README.md.
- Register every API endpoint with `defineRoute()` in `backend/src/http/route.js`. It enforces sign-in, the role permission (`backend/src/auth/policy.js`) and writes the audit entry in the same transaction. Set `ctx.audit.entityType/entityId/bookingId/details` in the handler.
- Time: use `backend/src/lib/time.js` (`toIstSql`, `toIstIso`, `formatIstDate`). DB `DATETIME(3)` columns hold IST wall-clock time.
- Logging: `backend/src/lib/logger.js` only; it redacts via `backend/src/lib/sanitize.js`.
- Store: repositories live in `backend/src/db/mariadb-store.js`, mirrored by `memory-store.js` for tests. Add a method to both.
- Schema changes: new numbered file in `backend/migrations/`; never edit an applied one.

## Domain notes (from the PRD)

- Roles: sales, sales coordinators, hospitality (admin-like for bookings), admins, and vendor hotels (passcode link, expires at check-out).
- Sign-in: `@alembic.co.in` email added by an admin; email OTP or saved password. Employees confirm a booking with an emailed OTP to their predefined email.
- One shared booking link; the employee picks their name from the uploaded list.
- Reminders: 5 days and 1 day before the deadline, then daily while overdue until submitted or cancelled. Only hospitality can extend or reopen a finalised booking.
- Aadhaar only (ID type kept configurable). Delete files after every trip; hospitality can delete manually. Cancellations can optionally delete Aadhaar and are undoable.
- Vacant rows in the employee list are excluded from every process.
- Email is sent from support@alembic.co.in (Hostinger, 3,000 outbound a day per mailbox, 100 recipients per message). Track queued, sent, delivered, bounced, opened, clicked.
- Hotels see a room-wise sheet from the rooming list. The analytics dashboard shows segments only: no individual employees and no Aadhaar data.
- External guests are out of scope.
