# PRD: Aadhaar Collection Portal

Oct 14, 2026 · @Digilabs

## Overview

The portal replaces ad-hoc WhatsApp and email collection of Aadhaar copies with one tracked workflow (sales coordinator, hospitality, hotel), so every traveller's ID is on file at least 7 days before check-in and is deleted when the trip ends. ***Version 1.0, finalised on 14/10/2026 as the single source of truth for build. Items marked (proposed) are recommended defaults accepted at sign-off; change them through admin settings or a revision of this document***.

**Problem.** Field and HO employees send IDs through personal chats. Coordinators cannot see who is pending, hotels receive scattered files at the last minute, and copies of Aadhaar stay on phones and inboxes indefinitely.

**Goals**

- Every traveller submits Aadhaar by booking start minus 7 days, or is visibly flagged to hospitality.
- Coordinators see sent, opened, submitted and pending counts per booking without chasing.
- Hotels get one link with all IDs for check-in, with per-guest verification.
- Aadhaar files exist only for the life of the booking and are deleted automatically.

**Non-goals for v1**

- Automated WhatsApp sending (WhatsApp stays copy-paste; email is sent by the system).
- Validating Aadhaar numbers against UIDAI.
- Hotel search, booking, payment or room-allocation logic. External guests who are not on the employee list are out of scope.

**Success metrics**

| Metric | Target |
| --- | --- |
| Travellers compliant at T-7 days | 90% or more *(proposed)* |
| Aadhaar files left after retention date | 0 |
| Hotel check-in ID requests outside the portal | 0 |
| Coordinator time to produce a pending-list chase | under 2 minutes |

## Roles and permissions

Five roles; only internal users have accounts, while employees and hotels use tokenised links so they never need a password.

| Role | Who | Can do | Cannot do | Sign-in *(proposed)* |
| --- | --- | --- | --- | --- |
| Sales coordinator | One or more per division (Marketing, Business Enablers) | Create bookings, upload employee list and rooming list, copy messages, track status, finalise | See other divisions' bookings, extend deadlines, view Aadhaar images after finalise | @alembic.co.in email + OTP or password |
| Hospitality | Whole team, individual logins, shared visibility | See and edit every booking, extend deadlines, manage emergency contacts, send hotel link, delete files | Be anonymous: every action is logged to the person's email | @alembic.co.in email + OTP or password |
| Employee | Field and HO travellers on a booking | Upload or replace own Aadhaar before deadline | See anyone else's data | Shared booking link; picks own name from the uploaded list, then an OTP emailed to the listed email |
| Hotel | Vendor staff for one booking | View, download and verify guests for that booking | See other bookings, edit details, access after expiry | Unique link + passcode |
| Admin | Digilabs | Manage coordinators, hospitality users, divisions, hotels, zones, HQs and settings | View Aadhaar files | @alembic.co.in email + OTP or password |

**Sign-in for internal users.** Only an @alembic.co.in email that an admin has added can sign in; the domain check alone never grants access.

- Two methods: a one-time code sent to the email, or a password. Login fields carry the standard username and password hints so Chrome, Edge and Safari offer to save the password.
- Passwords are stored as salted hashes (Argon2 or bcrypt), minimum 10 characters, with a 15-minute lock of password sign-in after 5 failed attempts (the emailed code still works) and reset through an emailed code *(proposed)*.
- Deactivating a user in the admin console ends their sessions immediately.
- Every action is attributed to the signed-in email, which keeps hospitality's shared visibility auditable.

**Code limits and health check.** One-time codes are 6 digits, expire after 10 minutes, allow 5 tries, and can be requested once a minute and five times an hour. Sign-in responses never reveal whether an email is on the allow-list. The health-check endpoint is the only endpoint that skips the audit log; it touches no data.

## Booking flow

&#91;embedded content: booking flow · 7 steps, 1 gate\]

A booking reaches hospitality only after the checklist passes; pending employees loop back to the coordinator as escalation messages, and files are deleted after check-out.

## Functional requirements

IDs are stable so build tasks and test cases can refer to them. P1 = launch scope, P2 = after launch.

| ID | Requirement | Phase |
| --- | --- | --- |
| B1 | Coordinator creates any number of bookings with hotel name, travel period (check-in and check-out, DD/MM/YYYY), event name, location and employee list | P1 |
| B2 | Employee list import from CSV or XLSX using a downloadable template (name, employee code, email, mobile, department, zone, HQ, vacant yes or no; email is required on every non-vacant row because the OTP is emailed, while vacant rows may leave name, email and mobile blank); preview with row-level errors for duplicates and invalid mobile or email before saving | P1 |
| B3 | Coordinator can add, remove or replace employees until finalise; each change is logged | P1 |
| B4 | Booking status moves Draft, Collecting, Finalised, With hospitality, Shared with hotel, Completed, Files deleted; Cancelled possible at any point | P1 |
| C1 | One shared, unguessable link per booking; the employee identifies themselves from the uploaded list (employee code), then confirms with an OTP emailed to the listed email before upload | P1 |
| C2 | WhatsApp: one ready-to-copy message carrying the single booking link, for the coordinator to post in a group. Email: the system sends to the listed employees, each with a personal link for open tracking *(confirmed)* | P1 |
| C3 | Coordinator can mark employees as "sent", as a fallback for WhatsApp recipients, because delivery there cannot be seen by the system; email is tracked automatically | P1 |
| C4 | Upload page shows the Aadhaar guide: PVC card needs front and back, old vertical card needs front only; JPG, PNG, HEIC or PDF only; consent tick; preview; replace allowed until deadline | P1 |
| C5 | Server compresses and sanitises every file (see business rules) | P1 |
| T1 | Booking dashboard: total, sent, opened, submitted, pending, overdue, verified | P1 |
| T2 | Per-employee status table with filters and CSV export that never includes Aadhaar images | P1 |
| T3 | Escalation message generator for non-compliant employees, staged: reminder, final reminder, manager escalation | P1 |
| R1 | Rooming list Excel upload (occupancy, room group, zone, HQ per employee); downloadable template, columns configurable, versioned, replaceable later; validated against the employee list | P1 |
| F1 | Six-item checklist (employee list, basic travel details, Aadhaar collection, rooming list, emergency details, hotel or vendor verification); Finalise enables when the coordinator's items 1 to 4 are done or approved by hospitality | P1 |
| F2 | After finalise the booking is read-only for the coordinator; only hospitality can reopen it or change it | P1 |
| H1 | Hospitality dashboard across all divisions with filters for status, division, hotel and date | P1 |
| H2 | Hospitality can edit any booking field, employee or submission; every edit is logged with the user's email | P1 |
| H3 | Hospitality extends a deadline per booking or per employee, with a mandatory reason | P1 |
| H4 | Emergency contacts per booking: one or more POCs (name, phone), editable at any time | P1 |
| H5 | Hospitality generates, copies, regenerates and revokes the hotel link, with an expiry and passcode | P1 |
| H6 | Hospitality deletes files singly, in selection or all at once, after a confirmation | P1 |
| V1 | Hotel views booking, emergency contacts and guest list; views and downloads each Aadhaar or all as one ZIP; verifies one or many guests; sees the rooming list as a room-wise sheet (room group, occupancy, guests, verified status; zone and HQ hidden) and can download it | P1 |
| A1 | Nightly job deletes files of expired bookings and writes the result to the audit log | P1 |
| A2 | Audit log of view, download, edit, extend, delete and verify, with user, time and IP | P1 |
| X1 | Automated WhatsApp sending with delivery receipts (email sending is already in P1) | P2 |
| X2 | OCR-based checks: blur, card type, name match, Aadhaar number checksum | P2 |

## Business rules

The deadline for both employee submissions and the rooming list is check-in date minus 7 days; only hospitality can move it.

| Rule | Definition |
| --- | --- |
| Deadline | 23:59 IST on (check-in date minus 7 days). Same date for Aadhaar and rooming list *(proposed)* |
| Short-notice booking | If created fewer than 7 days before check-in, the booking is flagged "short notice" and hospitality sets the deadline *(proposed)* |
| Extension | Hospitality only; per booking or per employee; reason required; logged |
| After deadline | Employee link shows "contact hospitality"; rooming list upload locks; coordinator can still view status |
| Card rule | PVC card: front and back required. Old vertical card: front only. Employee chooses the type on the page |
| Accepted files | JPG, PNG, HEIC (converted) and PDF; type checked by content, not file name; up to 10 MB before compression; PDFs up to 3 pages and not password-protected *(proposed)* |
| Compression | Images re-encoded to JPEG at roughly quality 85, long edge capped near 2400 px, EXIF and GPS data removed; text on the card must stay readable at full zoom. PDFs are kept as-is unless over the size cap *(proposed)* |
| Date format | DD/MM/YYYY everywhere on screen and in imports; stored as ISO dates; all times in IST |
| Finalise | Allowed only when the checklist is complete; locks the coordinator out of edits |
| Hotel link | Valid from the moment hospitality shares it until check-out date; can be revoked at any time |
| Auto-deletion | Files are hard-deleted at 02:00 IST on the day after check-out *(proposed)*, including compressed copies and thumbnails; booking metadata and audit log stay |
| Manual deletion | Hospitality can delete any file at any time; the employee's status reverts to "pending" unless the booking is already completed |
| Verified flag | Set only by the hotel (or hospitality on their behalf); survives file deletion |

**Vacant positions.** Some rows in the employee list are positions nobody will fill. The coordinator marks them as vacant in the upload itself (a Vacant column with yes or no in the template).

- Vacant rows are imported and counted as headcount, but excluded from invitations, reminders, escalations, pending and compliance counts, the rooming list, the hotel guest list and every deadline.
- The import shows how many rows are vacant before saving, so the coordinator can check the file.
- The coordinator can flip a row between vacant and active until finalise; hospitality can do it at any time, and the change is logged.
- Analytics report vacant positions separately and never count them against compliance.

## Checklist, rooming list and cancellations

The six-item checklist spans all roles: the coordinator owns items 1 to 4 and finalises, hospitality owns item 5, and item 6 is the optional hotel check *(confirmed)*.

| # | Item | Owner | Done when |
| --- | --- | --- | --- |
| 1 | Employee list | Coordinator | List imported with no blocking errors |
| 2 | Basic travel details | Coordinator | Hotel, travel period, event and location filled |
| 3 | Aadhaar collection | Employees | Every guest has submitted or is cancelled, or hospitality approved an exception |
| 4 | Rooming list | Coordinator | File uploaded and validated before the deadline |
| 5 | Emergency details | Hospitality | At least one contact with name and phone |
| 6 | Hotel or vendor verification (optional) | Hotel, or hospitality on their behalf | Every non-cancelled guest verified |

Finalise unlocks when items 1 to 4 are done; the booking becomes Completed when item 5 is done; item 6 is optional and never blocks completion.

**Rooming list.** The Excel format is not final, so the system stores whatever is uploaded and checks only a small core.

- Core columns *(proposed)*: employee code, occupancy (single, double or triple), room group (same value means same room), zone, HQ.
- Other columns are kept and shown as uploaded. The required columns are a setting an admin can change without a code release.
- Missing core columns or an unknown employee block the upload; everything else is a warning, and a room group whose size does not match its occupancy is a warning.
- It can be updated later: each upload is a new version and old versions stay in history. The coordinator can replace it until the deadline; hospitality can replace it at any time, including after finalise.

**Cancellations.** Hospitality can mark one or many guests as cancelled at any stage, including after hotel verification. It is optional and manual: last-minute cancellations are handled by a person first and recorded afterwards as proof.

- CX1. Mark singly or in bulk, with a note or comment (required; one line is enough and one note can cover a bulk selection) and an optional date and time the cancellation was communicated; the system stamps who recorded it and when.
- CX2. No approval step and only the note is mandatory, so it takes seconds under time pressure.
- CX3. Cancelled guests leave pending counts, deadlines and reminders, and show as "Cancelled" (not removed) on hospitality and hotel views so the check-in desk does not expect them.
- CX4. A tickbox "also delete Aadhaar files" is ticked by default *(proposed)*; the cancellation record itself stays.
- CX5. Hospitality can undo a cancellation; the undo is logged.
- CX6. Cancellations are reported in analytics separately and never count against compliance.

## Privacy, security and compliance

Aadhaar copies are sensitive personal data, so the design assumes the Digital Personal Data Protection Act 2023 and the Aadhaar Act apply; Alembic's legal or data-protection owner should confirm this before launch (this is not legal advice).

- **Consent and purpose.** Before upload the employee sees who will access the file, why (hotel check-in) and when it is deleted, and must tick consent. The consent time and wording version are stored.
- **Storage.** Files are encrypted at rest, kept outside the web root, never served from a public URL, and delivered only through authenticated, short-lived signed links.
- **No Aadhaar number in the database** in P1. Only file references, status and audit data are stored.
- **Least privilege.** Each role sees only what the table in the roles section allows; coordinators lose image access once a booking is finalised.
- **Hotel link.** Passcode or OTP, expiry at check-out, attempt limits, revocable, downloads logged and ZIPs watermarked with hotel name and booking ID *(proposed)*.
- **Audit.** Every view, download, edit, extension, verification and deletion is recorded with user, time and IP, and the log is retained after files are deleted.
- **Transport and sessions.** HTTPS only with HSTS; tokens never written to logs or URLs shared by analytics.
- **Backups.** Uploaded files are excluded from routine backups, or backed up encrypted with a lifespan no longer than the retention rule, so deletion is real.
- **Hosting.** Servers located in India.
- **Incident process.** A named owner and a written breach-response step exist before go-live.

**Booking history log (A3).** Every booking has its own history timeline, readable by admins and by hospitality.

- Each entry shows time, who (name and role, or "employee" or "hotel" with the guest or hotel name), what changed (old and new value where relevant), and IP address.
- It covers the full lifecycle: creation, list imports, status changes, submissions, extensions, rooming list versions, finalise and reopen, cancellations and vacancy changes, hotel link actions, views and downloads of Aadhaar files, verifications, deletions, and every email sent with its delivery stages.
- Filter by action type, person and date; export to CSV. The log never contains Aadhaar images or numbers.
- Entries cannot be edited or deleted by anyone, including admins. The log stays after the booking's files are deleted.

## Messages and tracking

The system can only see what happens on its own pages: email is tracked automatically through a personal link, while a WhatsApp group link is counted only once an employee identifies themselves on the page.

| Status | Meaning | Set by |
| --- | --- | --- |
| Not sent | In the list, link not yet shared | Default |
| Sent | Coordinator shared the link | System for email; coordinator for WhatsApp |
| Opened | Employee identified themselves on the booking page (email: personal link loaded) | System |
| Submitted | All required files uploaded | System |
| Verified | Hotel confirmed the ID at check-in | Hotel or hospitality |
| Overdue | Deadline passed, not submitted | System |

Invitation message (WhatsApp or email), the WhatsApp group version carries one booking link for everyone; the emailed version adds the person's name and a personal link:

```markdown
Hi team, Aadhaar upload for {event} at {hotel} ({check_in} to {check_out}), {location}.
Open {booking_link}, pick your name, verify with the OTP and upload by {deadline}.
PVC card: front and back. Old vertical card: front only. Photo or PDF.
Your copy is used only for hotel check-in and is deleted after the trip.
```

Escalation message, staged by days left to the deadline:

```markdown
Hi {first_name}, your Aadhaar for {event} at {hotel} is still pending. The deadline is {deadline} ({days_left} days left).
Link: {link}
Without it the hotel cannot confirm your room. Please upload today.
```

The manager-level escalation (stage 3) lists the pending names for one reporting manager and is generated once per manager.

**Email delivery.** The system sends invitations, reminders and escalations from support@alembic.co.in when an event triggers them: the coordinator clicks Send invitations, a reminder schedule fires, or the coordinator or hospitality clicks Send now. Every message is tracked:

| Stage | Meaning | How we know |
| --- | --- | --- |
| Queued | Waiting in the send queue | System |
| Sent | Accepted by the mail server | Mail server response |
| Delivered | Accepted by the recipient's server, no bounce | Absence of a bounce within a set window |
| Bounced | Rejected (bad address, full mailbox) | Bounce message read from a monitored mailbox |
| Opened | Tracking pixel loaded or link clicked | Pixel and personal link |
| Clicked | Personal link used | Personal link |

A mail app cannot prove a human read the message, so "received properly" means Delivered, and "seen" means Opened or Clicked. *Reminder schedule (confirmed): 5 days and 1 day before the deadline, then daily while overdue until the guest submits or is cancelled*.

## Analytics and admin console

A read-only dashboard shows the product owner and leadership whether the process is used properly, where bookings stall and which segments struggle; an admin console manages all master data. The dashboard holds no Aadhaar images or numbers, only counts, timings and event data, and shows segments (division, coordinator, hospitality user, hotel, zone, HQ) rather than individual employees *(proposed)*.

| Question | Metrics | Built from |
| --- | --- | --- |
| Is it used properly? | Bookings created 14 or more days before check-in; short-notice rate; bookings finalised before the deadline; extension rate | Booking and status events |
| Where do bookings stall? | Median days spent in each stage: created, invited, 90% submitted, rooming list in, finalised, hotel link shared, verified | Status change timestamps |
| Who is slow or struggling? | Compliance at 7 days before check-in, and days from invite to submit, by division, coordinator, hotel, zone and HQ | Submissions and bookings |
| Is the employee journey smooth? | Funnel: link opened, name picked, OTP verified, first file, submitted; failures by reason (file type, size, OTP, upload error); phone versus desktop | Upload page events |
| Are reminders working? | Sent, delivered, bounced, opened, clicked; submissions within 48 hours of a reminder | Email events |
| Is hospitality overloaded? | Extensions, post-finalise edits, reopens and cancellations per booking | Audit log |
| Does the hotel stage work? | Hours from link share to first view; share of guests verified before check-in | Hotel link events |
| Is retention honoured? | Files left after the retention date (target 0); manual deletions | Deletion job log |
| What is working well? | Bookings with 100% compliance at T-7; monthly trend | All of the above |

Views: (1) a leadership summary with five tiles (bookings this month, compliance at T-7, days to complete, extension rate, cancellation rate) and a monthly trend; (2) the booking-stage and employee funnels with drop-off at each step; (3) a bottleneck heatmap of days per stage by division and coordinator; (4) best and worst segments; (5) email performance. Filters: date range, division, hotel, zone, HQ. Every view exports to CSV and as an image for slides, and a one-click monthly summary exports as a PDF for the VP review; the primary reader is the product owner.

**Tracking.** The backend writes an events table (event name, role, booking, timestamp, properties) for every status change and key page step. No third-party analytics scripts load on pages that handle Aadhaar. Dashboard figures come from aggregate tables refreshed hourly. Analytics are kept after files are deleted because they contain no personal documents.

**Admin console (create, read, update, deactivate).**

| Entity | What is managed | Delete rule |
| --- | --- | --- |
| Sales coordinators | Name, @alembic.co.in email, division, active flag | Deactivate only, so history keeps its author |
| Divisions | Name, coordinators in it | Archive; blocked while bookings are open |
| Hospitality users | Name, email, active flag | Deactivate only |
| Hotels and vendors | Name, city, default contacts | Archive if used by any booking |
| Zones and HQs | Lists used to validate the rooming list | Archive |
| Analytics viewers | Product owner and leadership emails, read-only | Deactivate only |
| Settings | Deadline days (7), reminder schedule, retention timing, rooming list columns, message templates | Changes are versioned |

Hard deletion of bookings happens only through the retention policy.

## Technical design

The stack stays as given (React, Node.js, MariaDB, nginx, pm2 on port 17101); the one structural change recommended is to serve the API from the same site as the frontend.

| Layer | Choice |
| --- | --- |
| Frontend | React on alembicdigilabs.com, mobile-first because most employees upload from a phone |
| Backend | Node.js REST API on port 17101 behind nginx, run by pm2 |
| Database | MariaDB: users, divisions, hotels, bookings, employees, submissions, rooming lists, contacts, links, audit log |
| File storage | Encrypted directory outside the web root on the server, one folder per booking so whole-booking deletion is one operation |
| Image handling | Sharp for resize, re-encode and metadata strip; magic-byte file-type check; optional ClamAV scan |
| Import and export | SheetJS or similar for XLSX and CSV; streaming ZIP for hotel download |
| Scheduler | node-cron or a pm2 cron job for nightly deletion and deadline status updates |

**Domain split risk.** Frontend and API sit on two different registrable domains (.com and .in). Browsers block or limit cross-site cookies, so login sessions and CORS become fragile, especially on iPhones. Recommended *(proposed)*: expose the API at a path or subdomain of the frontend domain through nginx (for example alembicdigilabs.com/api), and keep alembicdigilabs.in as an alias or not at all.

**Core records.** Booking (hotel, dates, event, location, deadlines, status) has many Employees; each Employee has one tokenised Link and zero or more Files; a Booking also has RoomingListVersions, EmergencyContacts, HotelLink and an AuditLog.

**Email.** The system sends invitations, reminders and escalations from support@alembic.co.in by SMTP, each with a personal link; delivery stages are defined in Messages and tracking. Open tracking uses that link click plus a tracking pixel; pixels are unreliable when mail apps block images, so link clicks are the main signal.

**Sizing.** At 50 to 100 bookings of 50 to 400 employees, a busy cycle holds up to about 40,000 traveller records. With one or two files each at roughly 1 MB after compression, that is under about 80 GB if every booking were live at once, and a few GB in practice because files are deleted after each trip. Storage and compute are therefore small; one pm2-managed Node process and one MariaDB instance suffice, and a 400-guest ZIP must be streamed rather than built in memory. The real limit is email: a booking can mean 400 invitations plus several reminder rounds, so sends go through a throttled queue held below the daily cap of the support@alembic.co.in mailbox. Plan: Hostinger Business Standard (3,000 outbound a day per mailbox, 100 recipients per message, 20 GB), with every email sent as its own message; Business Premium has the same sending cap and only adds storage. SMTP gives no delivery receipts, so bounces are read from the same mailbox and delivery and open tracking are built into the portal.

## Open questions and phasing

All blocking decisions are made. Two items remain open and neither blocks the build.

| # | Question | Recommendation | Decision |
| --- | --- | --- | --- |
| 1 | One shared link per booking, or a unique link per employee? | Unique per employee; the brief's tracking needs it | Decided: shared link per booking; identify via the uploaded list + OTP |
| 2 | Re-upload Aadhaar for every trip, or keep it for later trips with consent? | Delete per trip, as the brief says; revisit after launch | Decided: delete after every trip |
| 3 | Are other IDs (passport, driving licence, voter ID) acceptable? | Aadhaar only in P1, with a field type ready for others | Decided: Aadhaar only; ID type kept configurable for later |
| 4 | Is masked Aadhaar acceptable to your hotels? | Ask 2 or 3 hotels before build | Open, not blocking: ask 2 or 3 hotels before build |
| 5 | Do hotels get accounts, or links only? | Links with passcode | Decided: link + passcode, expires at check-out |
| 6 | Do external guests (not on the employee master) appear on lists? | Yes, same flow | Decided: out of scope for now |
| 7 | Exact deletion moment after check-out | Next day 02:00 IST | Default adopted: next day 02:00 IST |
| 8 | Sign-in for coordinators and hospitality | Company SSO if available, else email OTP | Decided: @alembic.co.in email + OTP or password |
| 9 | Rooming list format and checklist items | Template to be shared by hospitality | Decided: Excel with occupancy, room group, zone, HQ; format can change later; 6-item checklist, item 6 optional |
| 10 | Expected volume: bookings per month, employees per booking | Needed to size storage and server | Estimated: 50 to 100 bookings, 50 to 400 employees each |

**Items to watch after launch.**

- Every non-vacant employee has a working predefined email (confirmed), and the import blocks non-vacant rows without one.
- WhatsApp recipients cannot be tracked before they identify themselves, so WhatsApp counts lag; the pending list is the reliable number.
- Hotel room-wise sheet: by default the hotel sees name, ID, room group, occupancy and verified status, and not employee code, email, zone or HQ; revisit if a hotel asks for more.
- If the 3,000-a-day mailbox cap is ever hit by overlapping large bookings, the queue spreads sends over more days; a second mailbox or a bulk-email service is the fallback.

**Phases.** P1 covers everything marked P1 in the requirements table. P2 adds automated WhatsApp and email sending, OCR quality checks and reuse of IDs across trips, once P1 compliance numbers are known.
