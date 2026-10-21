'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { buildTestApp, bookingBody, employee, importEmployees, DIVISIONS, request } = require('./helpers');
const { uploadWindow, bookingWindow } = require('../src/bookings/upload-lock');
const { sniffType } = require('../src/files/process-upload');
const { maskEmail } = require('../src/employees/identify');
const { deleteBookingFiles } = require('../src/files/deletion');

// M2: the employee page behind the shared booking link. Everything here runs against the
// real MariaDB test database and a throwaway encrypted storage folder.

const COORDINATOR = 'asha@alembic.co.in';
const OTHER_COORDINATOR = 'ravi@alembic.co.in';
const HOSPITALITY = 'hosp@alembic.co.in';
const ADMIN = 'admin@alembic.co.in';

// Shaped like an Aadhaar number (12 digits, 4-4-4). Synthetic, used to prove it never
// reaches a log line or the audit log.
const AADHAAR_LIKE_SAMPLE = '2345 6789 0123';
const AADHAAR_LIKE = /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/;

// --- Fixtures (all synthetic; nothing here is a real ID) -------------------------

const cardSvg = (w, h, text = 'TEST CARD') => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#dde6f0"/>`
  + `<text x="40" y="${Math.round(h / 2)}" font-size="${Math.round(h / 8)}" font-family="Helvetica">${text}</text></svg>`,
);

const jpeg = (w = 1200, h = 800, text) => sharp(cardSvg(w, h, text)).jpeg({ quality: 90 })
  .withMetadata({ exif: { IFD0: { Make: 'TestCam', Model: 'Fixture' } } }).toBuffer();
const png = (w = 900, h = 600) => sharp(cardSvg(w, h)).png().toBuffer();
const heic = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.heic'));

async function pdf(pages = 1, text = 'TEST CARD') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) doc.addPage([400, 250]).drawText(text, { x: 30, y: 120, size: 20, font });
  return Buffer.from(await doc.save());
}

async function encryptedPdf() {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// --- Shared set-up -----------------------------------------------------------------

describe('employee page (M2)', () => {
  let t;
  let coordinator;
  let hospitality;
  let bookingId;
  let token;
  let people; // employees on the booking, by name

  async function linkFor(agent, id) {
    const res = await agent.get(`/api/bookings/${id}/link`).expect(200);
    return { ...res.body, token: res.body.url.split('#/b/')[1] };
  }

  async function createBooking(agent, rows, body = bookingBody(), { collect = true } = {}) {
    const id = (await agent.post('/api/bookings').send(body).expect(201)).body.booking.id;
    await importEmployees(agent, id, rows).expect(201);
    if (collect) await agent.post(`/api/bookings/${id}/actions`).send({ action: 'start_collecting' }).expect(200);
    const detail = (await agent.get(`/api/bookings/${id}`).expect(200)).body;
    const byName = Object.fromEntries(detail.employees.map((e) => [e.name ?? `vacant:${e.employeeCode}`, e]));
    return { id, byName };
  }

  const openLink = (tok = token) => request(t.app).get('/api/e/link').set('X-Link-Token', tok);
  const search = (q, tok = token) => request(t.app).post('/api/e/people/search').set('X-Link-Token', tok).send({ q });
  const askCode = (agent, employeeId, tok = token) => agent.post('/api/e/identify/request').set('X-Link-Token', tok).send({ employeeId });
  const sendCode = (agent, employeeId, code, tok = token) => agent.post('/api/e/identify/verify').set('X-Link-Token', tok).send({ employeeId, code });

  /** Identifies as an employee and returns an agent carrying the employee session. */
  async function identify(person, tok = token) {
    const agent = request.agent(t.app);
    await askCode(agent, person.id, tok).expect(202);
    await sendCode(agent, person.id, t.lastCode(person.email), tok).expect(200);
    return agent;
  }

  const start = (agent, cardType = 'pvc') => agent.post('/api/e/submission').send({ cardType, consent: true, consentVersion: 'v1' });
  const upload = (agent, side, buffer) => agent.put(`/api/e/submission/files/${side}`)
    .set('Content-Type', 'application/octet-stream').send(buffer);
  const me = async (agent) => (await agent.get('/api/e/me').expect(200)).body;
  const fetchFile = (agent, url) => agent.get(url.replace(/^\/api/, '/api')).buffer(true).parse(binaryParser);

  async function fileRows() {
    return t.dump('submission_files');
  }

  async function decryptedStored(file) {
    return t.fileStore.read(file.bookingId, file.storageKey);
  }

  beforeEach(async () => {
    t = await buildTestApp();
    await t.seedUser({ email: COORDINATOR, name: 'Asha', role: 'coordinator', divisionId: DIVISIONS.MEGACARE });
    await t.seedUser({ email: OTHER_COORDINATOR, name: 'Ravi', role: 'coordinator', divisionId: DIVISIONS.MAXIS });
    await t.seedUser({ email: HOSPITALITY, name: 'Hosp', role: 'hospitality' });
    await t.seedUser({ email: ADMIN, name: 'Admin', role: 'admin' });
    coordinator = await t.signIn(COORDINATOR);
    hospitality = await t.signIn(HOSPITALITY);
    const booking = await createBooking(coordinator, [
      employee(1, { email: 'anita.k@alembic.co.in' }),
      employee(2),
      employee(3),
      { employeeCode: 'V1', isVacant: true },
    ]);
    bookingId = booking.id;
    people = booking.byName;
    ({ token } = await linkFor(coordinator, bookingId));
  });
  afterEach(() => t.close());

  // --- A. Booking link ------------------------------------------------------------

  describe('booking link', () => {
    it('gives coordinators one stable link and ready-to-copy WhatsApp and email texts', async () => {
      const first = await linkFor(coordinator, bookingId);
      const again = await linkFor(hospitality, bookingId);
      assert.equal(first.url, again.url, 'one shared link per booking');
      assert.match(first.url, /^https:\/\/portal\.test\/#\/b\/[A-Za-z0-9_-]{43}$/);

      const { whatsapp, email } = first.messages;
      for (const text of [whatsapp, email.body]) {
        assert.ok(text.includes(first.url), 'carries the link');
        assert.match(text, /Annual Sales Meet/);
        assert.match(text, /Taj Lands End/);
        assert.match(text, /30\/10\/2026 to 01\/11\/2026/);
        assert.match(text, /Mumbai/);
        assert.match(text, /23\/10\/2026 23:59 IST/, 'deadline in DD/MM/YYYY IST');
        assert.match(text, /PVC card: front and back\. Old vertical card: front only\./);
      }
      assert.match(email.subject, /Annual Sales Meet/);

      // Only the token's hash is stored.
      const [row] = await t.query('SELECT share_token_hash FROM bookings WHERE id = ?', [bookingId]);
      assert.match(row.share_token_hash, /^[0-9a-f]{64}$/);
      assert.ok(!row.share_token_hash.includes(first.token));
    });

    it('is not available to admins or to coordinators of other divisions', async () => {
      const admin = await t.signIn(ADMIN);
      await admin.get(`/api/bookings/${bookingId}/link`).expect(403);
      const other = await t.signIn(OTHER_COORDINATOR);
      await other.get(`/api/bookings/${bookingId}/link`).expect(404);
    });

    it('shows the booking but no names until the employee types, then names and codes only', async () => {
      await t.query('UPDATE booking_employees SET cancelled_at = NOW(3) WHERE id = ?', [people['Traveller 3'].id]);
      const res = await openLink().expect(200);
      assert.equal(res.body.window.open, true);
      assert.deepEqual(res.body.booking, {
        event: 'Annual Sales Meet', hotel: 'Taj Lands End', city: null, location: 'Mumbai', checkIn: '30/10/2026', checkOut: '01/11/2026',
      });
      assert.equal(res.body.people, undefined, 'no list of names on opening the link');
      assert.ok(!JSON.stringify(res.body).includes('Traveller'), 'no names at all');

      // Fewer than 2 characters: nothing.
      for (const q of ['', ' ', 't', '  T  ']) assert.deepEqual((await search(q).expect(200)).body.people, []);
      // By name (any case, middle of the name), and by employee code.
      const byName = (await search('VELLER').expect(200)).body.people;
      assert.deepEqual(byName.map((p) => p.name), ['Traveller 1', 'Traveller 2'], 'no vacant or cancelled rows');
      for (const p of byName) assert.deepEqual(Object.keys(p).sort(), ['employeeCode', 'id', 'name']);
      assert.deepEqual((await search('e0002').expect(200)).body.people.map((p) => p.name), ['Traveller 2']);
      assert.deepEqual((await search('Traveller 3').expect(200)).body.people, [], 'cancelled guest');
      assert.deepEqual((await search('V1').expect(200)).body.people, [], 'vacant row');
      assert.deepEqual((await search('zz').expect(200)).body.people, []);
      const raw = JSON.stringify(byName);
      assert.ok(!raw.includes('@'), 'no email addresses');
      assert.ok(!raw.includes('98765'), 'no mobile numbers');

      // The audit keeps the length and count, never the typed text.
      const searches = await t.auditEntries('employee.link.search');
      assert.ok(searches.every((e) => e.bookingId === bookingId));
      const veller = searches.find((e) => e.details.queryLength === 6);
      assert.deepEqual(veller.details, { queryLength: 6, matches: 2 });
      assert.ok(!JSON.stringify(searches).toLowerCase().includes('veller'));

      const [entry] = await t.auditEntries('employee.link.open');
      assert.equal(entry.bookingId, bookingId);
      assert.equal(entry.outcome, 'success');
    });

    it('refuses an unknown or malformed link, and audits it', async () => {
      await openLink('x'.repeat(43)).expect(404);
      await openLink('not a token').expect(404);
      await request(t.app).get('/api/e/link').expect(404);
      const entries = await t.auditEntries('employee.link.open');
      assert.equal(entries.length, 3);
      assert.ok(entries.every((e) => e.outcome === 'failure' && e.details.reason === 'invalid_link'));
    });

    it('shows a friendly message and no names for a cancelled or not-yet-started booking', async () => {
      const draft = await createBooking(coordinator, [employee(20)], bookingBody({ eventName: 'Draft trip' }), { collect: false });
      const draftLink = await linkFor(coordinator, draft.id);
      const res = await openLink(draftLink.token).expect(200);
      assert.equal(res.body.window.open, false);
      assert.equal(res.body.window.reason, 'not_started');
      await search('Traveller', draftLink.token).expect(409);

      await coordinator.post(`/api/bookings/${bookingId}/actions`).send({ action: 'cancel', note: 'Event moved' }).expect(200);
      const cancelled = await openLink().expect(200);
      assert.equal(cancelled.body.window.reason, 'booking_cancelled');
      assert.match(cancelled.body.window.message, /cancelled/);
      const closed = await search('Traveller').expect(409);
      assert.equal(closed.body.people, undefined);
      await askCode(request.agent(t.app), people['Traveller 1'].id).expect(409);
      assert.equal(t.mailCount(people['Traveller 1'].email), 0);
    });
  });

  // --- B. Identification ----------------------------------------------------------

  describe('identification', () => {
    it('emails a code to the listed address, shows it masked, and marks the invitation opened', async () => {
      const person = people['Traveller 1'];
      const agent = request.agent(t.app);
      const res = await askCode(agent, person.id).expect(202);
      assert.equal(res.body.maskedEmail, 'a***@alembic.co.in');
      assert.equal(res.body.message, 'A code was sent to your registered email a***@alembic.co.in.');
      assert.ok(!JSON.stringify(res.body).includes('anita'), 'full email never returned');
      const mail = t.mailer.outbox.at(-1);
      assert.equal(mail.to, 'anita.k@alembic.co.in');
      assert.match(mail.text, /\b\d{6}\b/);

      await agent.get('/api/e/me').expect(401);
      await sendCode(agent, person.id, t.lastCode(person.email)).expect(200);
      const page = await me(agent);
      assert.equal(page.employee.name, 'Traveller 1');
      assert.equal(page.employee.maskedEmail, 'a***@alembic.co.in');

      const detail = (await coordinator.get(`/api/bookings/${bookingId}`).expect(200)).body;
      const row = detail.employees.find((e) => e.id === person.id);
      assert.equal(row.inviteStatus, 'opened');
      assert.ok(row.openedAt);
      assert.equal(row.submissionStatus, 'pending');

      const [ok] = await t.auditEntries('employee.identify.verify');
      assert.equal(ok.outcome, 'success');
      assert.equal(ok.actorType, 'employee');
      assert.equal(ok.actorLabel, 'Traveller 1');
      assert.equal(ok.bookingId, bookingId);
    });

    it('rejects a wrong code and counts the try', async () => {
      const person = people['Traveller 2'];
      const agent = request.agent(t.app);
      await askCode(agent, person.id).expect(202);
      const right = t.lastCode(person.email);
      const wrong = right === '000000' ? '111111' : '000000';
      const res = await sendCode(agent, person.id, wrong).expect(401);
      assert.match(res.body.message, /not right/);
      await sendCode(agent, person.id, 'abc').expect(401);
      const [otp] = await t.dump('employee_otp_codes');
      assert.equal(otp.attempts, 2);
      await sendCode(agent, person.id, right).expect(200);
      const reasons = (await t.auditEntries('employee.identify.verify')).map((e) => e.details.reason ?? e.outcome);
      assert.deepEqual(reasons, ['wrong_code', 'wrong_code', 'success']);
    });

    it('locks the code after five wrong tries, even for the right code', async () => {
      const person = people['Traveller 2'];
      const agent = request.agent(t.app);
      await askCode(agent, person.id).expect(202);
      const right = t.lastCode(person.email);
      const wrong = right === '999999' ? '888888' : '999999';
      for (let i = 0; i < 4; i += 1) await sendCode(agent, person.id, wrong).expect(401);
      const fifth = await sendCode(agent, person.id, wrong).expect(401);
      assert.match(fifth.body.message, /Too many wrong tries/);
      const after = await sendCode(agent, person.id, right).expect(401);
      assert.match(after.body.message, /Too many wrong tries/);
      const last = (await t.auditEntries('employee.identify.verify')).at(-1);
      assert.equal(last.details.reason, 'attempts_exhausted');
    });

    it('rejects an expired code (after 10 minutes)', async () => {
      const person = people['Traveller 2'];
      const agent = request.agent(t.app);
      await askCode(agent, person.id).expect(202);
      t.clock.advanceMinutes(11);
      const res = await sendCode(agent, person.id, t.lastCode(person.email)).expect(401);
      assert.match(res.body.message, /expired/);
      assert.equal((await t.auditEntries('employee.identify.verify')).at(-1).details.reason, 'code_expired');
    });

    it('rejects a code that was already used', async () => {
      const person = people['Traveller 2'];
      await identify(person);
      const res = await sendCode(request.agent(t.app), person.id, t.lastCode(person.email)).expect(401);
      assert.match(res.body.message, /already used/);
      assert.equal((await t.auditEntries('employee.identify.verify')).at(-1).details.reason, 'code_already_used');
    });

    it('limits resends: once a minute, five an hour, and a new code replaces the old one', async () => {
      const person = people['Traveller 2'];
      const agent = request.agent(t.app);
      await askCode(agent, person.id).expect(202);
      const first = t.lastCode(person.email);
      const tooSoon = await askCode(agent, person.id).expect(429);
      assert.match(tooSoon.body.message, /seconds/);
      assert.equal(t.mailCount(person.email), 1);

      for (let i = 2; i <= 5; i += 1) {
        t.clock.advanceSeconds(61);
        await askCode(agent, person.id).expect(202);
      }
      t.clock.advanceSeconds(61);
      const capped = await askCode(agent, person.id).expect(429);
      assert.match(capped.body.message, /last hour/);
      assert.equal(t.mailCount(person.email), 5);

      // The first code was replaced by the later ones.
      if (first !== t.lastCode(person.email)) await sendCode(agent, person.id, first).expect(401);
      await sendCode(agent, person.id, t.lastCode(person.email)).expect(200);
      const throttled = (await t.auditEntries('employee.identify.request_code')).filter((e) => e.details.reason);
      assert.deepEqual(throttled.map((e) => e.details.reason), ['cooldown', 'hourly_limit']);
    });

    it('caps codes requested from one network across employees', async () => {
      t.config.employee.maxCodesPerIpPerHour = 2;
      await askCode(request.agent(t.app), people['Traveller 1'].id).expect(202);
      await askCode(request.agent(t.app), people['Traveller 2'].id).expect(202);
      const res = await askCode(request.agent(t.app), people['Traveller 3'].id).expect(429);
      assert.match(res.body.message, /this network/);
      assert.equal(t.mailCount(people['Traveller 3'].email), 0);
    });

    it('caps search results at 10 and says when there are more', async () => {
      const big = await createBooking(coordinator, Array.from({ length: 14 }, (_, i) => employee(100 + i)), bookingBody({ eventName: 'Big trip' }));
      const bigLink = await linkFor(coordinator, big.id);
      const res = await search('Traveller', bigLink.token).expect(200);
      assert.equal(res.body.people.length, 10);
      assert.equal(res.body.more, true);
      assert.equal((await search('Traveller 113', bigLink.token).expect(200)).body.more, false);
      // Another booking's link never finds this booking's travellers.
      assert.deepEqual((await search('Traveller 1', bigLink.token).expect(200)).body.people.filter((p) => p.name === 'Traveller 1'), []);
      await search('Traveller', 'x'.repeat(43)).expect(404);
    });

    it('never reaches an employee of another booking, a vacant row or a cancelled guest', async () => {
      const other = await createBooking(coordinator, [employee(9)], bookingBody({ eventName: 'Other trip' }));
      const outsider = other.byName['Traveller 9'];
      const vacant = people['vacant:V1'];
      await t.query('UPDATE booking_employees SET cancelled_at = NOW(3) WHERE id = ?', [people['Traveller 3'].id]);

      for (const [id, reason] of [[outsider.id, 'not_on_booking'], [vacant.id, 'vacant_row'], [people['Traveller 3'].id, 'employee_cancelled'], [999999, 'not_on_booking']]) {
        const agent = request.agent(t.app);
        const res = await askCode(agent, id).expect(404);
        assert.match(res.body.message, /could not find that name/);
        await sendCode(agent, id, '123456').expect(404);
        const entry = (await t.auditEntries('employee.identify.request_code')).at(-1);
        assert.equal(entry.outcome, 'denied');
        assert.equal(entry.details.reason, reason);
      }
      assert.equal(t.mailCount(outsider.email), 0);
      assert.equal(t.mailCount(people['Traveller 3'].email), 0);
      assert.equal(t.mailer.outbox.filter((m) => m.subject.includes('Aadhaar upload')).length, 0);

      // The other booking's own link works for its own traveller, and only for it.
      const otherLink = await linkFor(coordinator, other.id);
      await askCode(request.agent(t.app), people['Traveller 1'].id, otherLink.token).expect(404);
      await identify(outsider, otherLink.token);
    });

    it('a session for one booking cannot read or upload to another', async () => {
      const other = await createBooking(coordinator, [employee(9)], bookingBody({ eventName: 'Other trip' }));
      const agent = await identify(people['Traveller 1']);
      const page = await me(agent);
      assert.equal(page.booking.event, 'Annual Sales Meet');
      // There is no booking id to change: the session names its one employee.
      assert.ok(!('id' in page.booking));
      const otherLink = await linkFor(coordinator, other.id);
      await askCode(agent, people['Traveller 1'].id, otherLink.token).expect(404);
      // Opening the other booking's link with this session shows it as signed out.
      await agent.get('/api/e/me').set('X-Link-Token', otherLink.token).expect(401);
      await agent.get('/api/e/me').set('X-Link-Token', token).expect(200);
    });

    it('ends the session when the employee is cancelled', async () => {
      const agent = await identify(people['Traveller 2']);
      await t.query('UPDATE booking_employees SET cancelled_at = NOW(3) WHERE id = ?', [people['Traveller 2'].id]);
      await agent.get('/api/e/me').expect(401);
    });

    it('masks emails', () => {
      assert.equal(maskEmail('anita.k@alembic.co.in'), 'a***@alembic.co.in');
      assert.equal(maskEmail('x@example.com'), 'x***@example.com');
      assert.equal(maskEmail('broken'), '***');
    });
  });

  // --- C. Upload ----------------------------------------------------------------

  describe('upload', () => {
    it('shows the guide data, needs card type and consent, then takes front and back of a PVC card', async () => {
      const agent = await identify(people['Traveller 1']);
      const page = await me(agent);
      assert.deepEqual(page.cardTypes.map((c) => [c.key, c.sides]), [['pvc', ['front', 'back']], ['old_vertical', ['front']]]);
      assert.equal(page.consent.version, 'v1');
      assert.match(page.consent.text, /02\/11\/2026/, 'deletion date is the day after check-out');
      assert.equal(page.submission.status, 'pending');

      await upload(agent, 'front', await jpeg()).expect(409);
      await agent.post('/api/e/submission').send({ cardType: 'pvc', consent: false, consentVersion: 'v1' }).expect(400);
      await agent.post('/api/e/submission').send({ cardType: 'passport', consent: true, consentVersion: 'v1' }).expect(400);
      await start(agent).expect(201);

      const front = await upload(agent, 'front', await jpeg()).expect(201);
      assert.equal(front.body.completed, false);
      assert.equal(front.body.submission.status, 'pending');
      const back = await upload(agent, 'back', await png()).expect(201);
      assert.equal(back.body.completed, true);
      assert.equal(back.body.submission.status, 'submitted');
      assert.deepEqual(back.body.submission.current.files.map((f) => [f.side, f.mimeType]), [['front', 'image/jpeg'], ['back', 'image/jpeg']]);
      assert.equal(back.body.submission.draft, null);

      const [sub] = await t.dump('submissions');
      assert.equal(sub.consentVersion, 'v1');
      assert.ok(sub.consentAt);
      assert.equal(sub.cardType, 'pvc');

      const detail = (await coordinator.get(`/api/bookings/${bookingId}`).expect(200)).body;
      assert.equal(detail.employees.find((e) => e.name === 'Traveller 1').submissionStatus, 'submitted');
      assert.equal(detail.booking.counts.pending, 2);

      const uploads = await t.auditEntries('employee.upload');
      assert.deepEqual(uploads.map((e) => [e.outcome, e.details.side]), [['failure', 'front'], ['success', 'front'], ['success', 'back']]);
      const [submitted] = await t.auditEntries('employee.submission.submitted');
      assert.equal(submitted.actorType, 'employee');
      assert.equal(submitted.bookingId, bookingId);
    });

    it('takes one front image for an old vertical card', async () => {
      const agent = await identify(people['Traveller 2']);
      await start(agent, 'old_vertical').expect(201);
      await upload(agent, 'back', await jpeg()).expect(400);
      const res = await upload(agent, 'front', await jpeg()).expect(201);
      assert.equal(res.body.completed, true);
    });

    it('accepts one PDF for the whole card, up to 3 pages and not password-protected', async () => {
      const agent = await identify(people['Traveller 2']);
      await start(agent).expect(201);
      await upload(agent, 'front', await jpeg()).expect(201);
      const four = await upload(agent, 'document', await pdf(4)).expect(400);
      assert.match(four.body.message, /4 pages/);
      const locked = await upload(agent, 'document', await encryptedPdf()).expect(400);
      assert.match(locked.body.message, /password-protected/);

      const original = await pdf(2);
      const res = await upload(agent, 'front', original).expect(201);
      assert.equal(res.body.completed, true, 'a PDF covers front and back');
      assert.deepEqual(res.body.submission.current.files.map((f) => [f.side, f.mimeType, f.pageCount]), [['document', 'application/pdf', 2]]);
      // The front image was replaced by the PDF, and the PDF is kept as it is.
      const live = (await fileRows()).filter((f) => !f.deletedAt);
      assert.equal(live.length, 1);
      assert.ok((await decryptedStored(live[0])).equals(original));
    });

    it('rejects a fake file renamed to .jpg, and stores nothing', async () => {
      const agent = await identify(people['Traveller 2']);
      await start(agent).expect(201);
      const fake = Buffer.from(`This is a text file pretending to be photo.jpg ${'x'.repeat(200)}`);
      const res = await agent.put('/api/e/submission/files/front').set('Content-Type', 'image/jpeg').send(fake).expect(400);
      assert.equal(res.body.error, 'invalid_type');
      assert.match(res.body.message, /JPG, PNG or HEIC/);
      // JPEG magic bytes followed by junk: looks right, but cannot be read as an image.
      const truncated = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 1)]);
      const res2 = await upload(agent, 'front', truncated).expect(400);
      assert.equal(res2.body.error, 'unreadable_image');
      // An executable and an AVIF image are refused too.
      await upload(agent, 'front', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)])).expect(400);
      assert.equal((await fileRows()).length, 0);
      assert.deepEqual(await t.fileStore.listBooking(bookingId), []);
      const reasons = (await t.auditEntries('employee.upload')).map((e) => [e.outcome, e.details.reason]);
      assert.deepEqual(reasons, [['failure', 'invalid_type'], ['failure', 'unreadable_image'], ['failure', 'invalid_type']]);
    });

    it('rejects a file over 10 MB with a friendly message', async () => {
      const agent = await identify(people['Traveller 2']);
      await start(agent).expect(201);
      const big = Buffer.concat([await jpeg(), Buffer.alloc(10 * 1024 * 1024)]);
      const res = await upload(agent, 'front', big).expect(413);
      assert.match(res.body.message, /larger than 10 MB/);
      const [entry] = await t.auditEntries('employee.upload');
      assert.equal(entry.details.reason, 'too_large');
      assert.equal((await fileRows()).length, 0);
    });

    it('converts HEIC to JPEG on the server', async () => {
      const agent = await identify(people['Traveller 2']);
      await start(agent, 'old_vertical').expect(201);
      const res = await upload(agent, 'front', heic()).expect(201);
      assert.equal(res.body.submission.current.files[0].mimeType, 'image/jpeg');
      const [row] = await fileRows();
      const meta = await sharp(await decryptedStored(row)).metadata();
      assert.equal(meta.format, 'jpeg');
      assert.equal(meta.width, 640);
      assert.equal((await t.auditEntries('employee.upload'))[0].details.sourceType, 'heic');
    });

    it('compresses images: long edge 2400 px, JPEG, EXIF removed', async () => {
      const original = await jpeg(4000, 2600);
      assert.ok((await sharp(original).metadata()).exif, 'fixture has EXIF');
      const agent = await identify(people['Traveller 2']);
      await start(agent, 'old_vertical').expect(201);
      await upload(agent, 'front', original).expect(201);
      const [row] = await fileRows();
      const meta = await sharp(await decryptedStored(row)).metadata();
      assert.equal(meta.format, 'jpeg');
      assert.equal(Math.max(meta.width, meta.height), 2400);
      assert.equal(meta.width, 2400);
      assert.equal(meta.height, 1560);
      assert.equal(meta.exif, undefined);
      assert.equal(row.mimeType, 'image/jpeg');
    });

    it('lets the employee see their upload and replace it before the deadline', async () => {
      const agent = await identify(people['Traveller 2']);
      await start(agent, 'old_vertical').expect(201);
      await upload(agent, 'front', await jpeg()).expect(201);
      const before = await me(agent);
      const [firstFile] = before.submission.current.files;
      const preview = await fetchFile(agent, firstFile.url).expect(200);
      assert.equal(preview.headers['content-type'], 'image/jpeg');
      assert.match(preview.headers['content-disposition'], /^inline/);
      assert.equal(preview.headers['cache-control'], 'no-store');
      assert.equal((await sharp(preview.body).metadata()).format, 'jpeg');
      const [oldRow] = await fileRows();

      // Replace: a new card type and file. The old one stays valid until the new one is complete.
      await start(agent, 'pvc').expect(201);
      const mid = await me(agent);
      assert.equal(mid.submission.status, 'submitted');
      assert.equal(mid.submission.current.files[0].id, firstFile.id);
      await upload(agent, 'front', await jpeg()).expect(201);
      const done = await upload(agent, 'back', await jpeg()).expect(201);
      assert.equal(done.body.completed, true);
      assert.equal(done.body.submission.current.files.length, 2);

      // The replaced file is gone from disk and marked deleted.
      const rows = await fileRows();
      assert.ok(rows.find((r) => r.id === oldRow.id).deletedAt);
      assert.deepEqual((await t.fileStore.listBooking(bookingId)).sort(), rows.filter((r) => !r.deletedAt).map((r) => r.storageKey).sort());
      await fetchFile(agent, firstFile.url).expect(404);
      const [replaced] = await t.auditEntries('employee.submission.replaced');
      assert.equal(replaced.outcome, 'success');
    });

    it('replaces a side within an unfinished upload', async () => {
      const agent = await identify(people['Traveller 2']);
      await start(agent).expect(201);
      await upload(agent, 'front', await jpeg()).expect(201);
      await upload(agent, 'front', await png()).expect(201);
      const live = (await fileRows()).filter((r) => !r.deletedAt);
      assert.equal(live.length, 1);
      assert.equal((await t.fileStore.listBooking(bookingId)).length, 1);
    });
  });

  // --- D. Secure storage ------------------------------------------------------------

  describe('storage and file access', () => {
    async function submitted(person = people['Traveller 1']) {
      const agent = await identify(person);
      await start(agent, 'old_vertical').expect(201);
      await upload(agent, 'front', await jpeg(1200, 800, 'SECRET-PIXELS')).expect(201);
      return agent;
    }

    it('encrypts files at rest under random names, outside anything served', async () => {
      await submitted();
      const [row] = await fileRows();
      assert.match(row.storageKey, /^[0-9a-f]{64}$/);
      assert.equal(row.bookingId, bookingId);
      const onDisk = path.join(t.fileStore.root, String(bookingId), `${row.storageKey}.bin`);
      const raw = fs.readFileSync(onDisk);
      assert.equal(raw.subarray(0, 4).toString(), 'ACP1');
      const plain = await decryptedStored(row);
      assert.equal(plain[0], 0xff, 'decrypts to the JPEG');
      assert.ok(raw.indexOf(plain.subarray(0, 64)) === -1, 'no plaintext on disk');
      assert.ok(!onDisk.includes('Traveller') && !onDisk.includes('E0001'));
      assert.equal(fs.statSync(onDisk).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(onDisk)).mode & 0o777, 0o700);
      // Swapping the stored bytes is detected.
      const tampered = Buffer.from(raw);
      tampered[tampered.length - 1] ^= 1;
      fs.writeFileSync(onDisk, tampered);
      await assert.rejects(() => decryptedStored(row));
    });

    it('serves files to staff only through short-lived signed links, by policy', async () => {
      await submitted();
      const person = people['Traveller 1'];
      const list = await coordinator.get(`/api/bookings/${bookingId}/employees/${person.id}/files`).expect(200);
      const [file] = list.body.current.files;
      assert.match(file.url, /^\/api\/files\/\d+\?exp=\d+&sig=[0-9a-f]{64}$/);
      const res = await fetchFile(coordinator, file.url).expect(200);
      assert.equal(res.headers['content-type'], 'image/jpeg');

      // The link is tied to the person who asked for it, and to their session.
      await fetchFile(hospitality, file.url).expect(403);
      await fetchFile(request.agent(t.app), file.url).expect(401);
      const hospUrl = (await hospitality.get(`/api/bookings/${bookingId}/employees/${person.id}/files`).expect(200)).body.current.files[0].url;
      await fetchFile(hospitality, hospUrl).expect(200);
      // A tampered signature fails.
      await fetchFile(coordinator, file.url.replace(/sig=./, (m) => (m.endsWith('a') ? 'sig=b' : 'sig=a'))).expect(403);
      // It expires after 5 minutes.
      t.clock.advanceSeconds(301);
      await fetchFile(coordinator, file.url).expect(403);

      // Admins never see Aadhaar; other divisions get "not found".
      const admin = await t.signIn(ADMIN);
      await admin.get(`/api/bookings/${bookingId}/employees/${person.id}/files`).expect(403);
      await fetchFile(admin, file.url).expect(403);
      const other = await t.signIn(OTHER_COORDINATOR);
      await other.get(`/api/bookings/${bookingId}/employees/${person.id}/files`).expect(404);

      // Coordinators lose access after finalise; hospitality keeps it.
      await t.query("UPDATE bookings SET status = 'finalised' WHERE id = ?", [bookingId]);
      await coordinator.get(`/api/bookings/${bookingId}/employees/${person.id}/files`).expect(403);
      const late = (await hospitality.get(`/api/bookings/${bookingId}/employees/${person.id}/files`).expect(200)).body.current.files[0].url;
      await fetchFile(hospitality, late).expect(200);

      const views = await t.auditEntries('aadhaar.file.view');
      assert.ok(views.some((v) => v.outcome === 'success' && v.actorEmail === COORDINATOR && v.bookingId === bookingId));
      assert.ok(views.some((v) => v.outcome === 'denied' && v.details.reason === 'link_expired'));
    });

    it('an employee sees only their own files', async () => {
      const owner = await submitted(people['Traveller 1']);
      const url = (await me(owner)).submission.current.files[0].url;
      const intruder = await identify(people['Traveller 2']);
      await fetchFile(intruder, url).expect(404);
      await fetchFile(request.agent(t.app), url).expect(401);
      const entry = (await t.auditEntries('employee.file.view')).find((e) => e.outcome === 'denied');
      assert.equal(entry.details.reason, 'not_own_file');
    });

    it('deletion hook removes every file of a booking from disk and marks it', async () => {
      await submitted(people['Traveller 1']);
      await submitted(people['Traveller 2']);
      // Something a crashed request left behind is removed too.
      await t.fileStore.save(bookingId, Buffer.from('orphan'));
      assert.equal((await t.fileStore.listBooking(bookingId)).length, 3);

      const result = await t.store.transaction((tx) => deleteBookingFiles(tx, t.fileStore, bookingId, { reason: 'retention', at: '2026-11-02 02:00:00.000' }));
      assert.deepEqual(result, { files: 2, submissions: 2 });
      assert.deepEqual(await t.fileStore.listBooking(bookingId), []);
      assert.ok((await fileRows()).every((r) => r.deletedAt === '2026-11-02 02:00:00.000'));
      assert.ok((await t.dump('submissions')).every((s) => s.filesDeletedReason === 'retention'));
      // Running it again finds nothing.
      const again = await t.store.transaction((tx) => deleteBookingFiles(tx, t.fileStore, bookingId, { reason: 'retention', at: '2026-11-02 02:00:00.000' }));
      assert.deepEqual(again, { files: 0, submissions: 0 });
    });

    it('removing a traveller deletes their files; replacing the whole list is refused once anyone has uploaded', async () => {
      await submitted(people['Traveller 1']);
      const blocked = await importEmployees(coordinator, bookingId, [employee(5)]).expect(409);
      assert.match(blocked.body.message, /already uploaded/);
      await coordinator.delete(`/api/bookings/${bookingId}/employees/${people['Traveller 1'].id}`).expect(204);
      assert.deepEqual(await t.fileStore.listBooking(bookingId), []);
      assert.equal((await fileRows()).length, 0);
      const [entry] = await t.auditEntries('bookings.employees.remove');
      assert.equal(entry.details.filesDeleted, 1);
      await importEmployees(coordinator, bookingId, [employee(5)]).expect(201);
    });

    it('swapping in a different person drops the previous person\'s upload', async () => {
      await submitted(people['Traveller 1']);
      await coordinator.put(`/api/bookings/${bookingId}/employees/${people['Traveller 1'].id}`).send(employee(7)).expect(200);
      assert.deepEqual(await t.fileStore.listBooking(bookingId), []);
      const detail = (await coordinator.get(`/api/bookings/${bookingId}`).expect(200)).body;
      assert.equal(detail.employees.find((e) => e.name === 'Traveller 7').submissionStatus, 'pending');
    });
  });

  // --- E. Deadline ------------------------------------------------------------------

  describe('deadline lock', () => {
    it('locks uploads after 23:59 IST on the deadline, audited as denied', async () => {
      // Deadline 20 minutes from now, so the 30-minute employee session outlives it.
      await t.query("UPDATE bookings SET deadline_at = '2026-10-14 10:20:00.000' WHERE id = ?", [bookingId]);
      const agent = await identify(people['Traveller 2']);
      await start(agent, 'old_vertical').expect(201);
      t.clock.advanceMinutes(21);
      const res = await upload(agent, 'front', await jpeg()).expect(409);
      assert.equal(res.body.error, 'upload_closed');
      assert.match(res.body.message, /deadline .* has passed.*contact hospitality/i);
      await start(agent, 'pvc').expect(409);
      const page = await me(agent);
      assert.equal(page.window.open, false);
      assert.equal(page.window.reason, 'deadline_passed');

      const [entry] = await t.auditEntries('employee.upload');
      assert.equal(entry.outcome, 'denied');
      assert.equal(entry.details.reason, 'deadline_passed');
      assert.equal((await fileRows()).length, 0);

      const link = await openLink().expect(200);
      assert.equal(link.body.window.reason, 'deadline_passed');
      await search('Traveller').expect(409);
      await askCode(request.agent(t.app), people['Traveller 3'].id).expect(409);
    });

    it('the deadline is end of day: 23:59:59 IST counts, midnight does not', () => {
      const booking = { id: 1, status: 'collecting', deadlineAt: '2026-10-23 23:59:59.999' };
      const at = (iso) => new Date(iso);
      assert.equal(uploadWindow(booking, null, at('2026-10-23T23:59:59.000+05:30')).open, true);
      assert.equal(uploadWindow(booking, null, at('2026-10-24T00:00:00.000+05:30')).reason, 'deadline_passed');
      // UTC server clocks make no difference: 18:29 UTC is 23:59 IST.
      assert.equal(uploadWindow(booking, null, at('2026-10-23T18:29:30.000Z')).open, true);
    });

    it('shared lock rules: status, vacant, cancelled, personal extension, no deadline', () => {
      const now = new Date('2026-10-20T12:00:00+05:30');
      const booking = { id: 1, status: 'collecting', deadlineAt: '2026-10-19 23:59:59.999' };
      const person = { id: 5, bookingId: 1, isVacant: false, cancelledAt: null, deadlineOverrideAt: null };
      assert.equal(uploadWindow(booking, person, now).reason, 'deadline_passed');
      assert.equal(uploadWindow(booking, { ...person, deadlineOverrideAt: '2026-10-21 23:59:59.999' }, now).open, true);
      assert.equal(uploadWindow(booking, { ...person, isVacant: true }, now).reason, 'not_on_booking');
      assert.equal(uploadWindow(booking, { ...person, bookingId: 2 }, now).reason, 'not_on_booking');
      assert.equal(uploadWindow(booking, { ...person, cancelledAt: '2026-10-18 10:00:00.000' }, now).reason, 'employee_cancelled');
      for (const status of ['finalised', 'with_hospitality', 'shared_with_hotel', 'completed', 'files_deleted']) {
        assert.equal(uploadWindow({ ...booking, status, deadlineAt: '2026-12-01 23:59:59.999' }, person, now).reason, 'closed');
      }
      assert.equal(uploadWindow({ ...booking, deadlineAt: null }, person, now).reason, 'no_deadline');
      // The link page stays open while someone has a running extension.
      const extended = [{ ...person, deadlineOverrideAt: '2026-10-21 23:59:59.999' }];
      assert.equal(bookingWindow(booking, [person], now).open, false);
      assert.equal(bookingWindow(booking, extended, now).open, true);
    });

    it('only hospitality extends: per employee and per booking, with a reason', async () => {
      t.clock.advanceDays(10); // past 23/10/2026 23:59 IST
      coordinator = await t.signIn(COORDINATOR); // staff sessions expired meanwhile
      hospitality = await t.signIn(HOSPITALITY);
      const person = people['Traveller 2'];
      await coordinator.post(`/api/bookings/${bookingId}/deadline`).send({ date: '26/10/2026', reason: 'Late list' }).expect(403);
      await hospitality.post(`/api/bookings/${bookingId}/employees/${person.id}/deadline`).send({ date: '26/10/2026' }).expect(400);
      await hospitality.post(`/api/bookings/${bookingId}/employees/${person.id}/deadline`).send({ date: '20/10/2026', reason: 'x' }).expect(400);
      await askCode(request.agent(t.app), person.id).expect(409);

      await hospitality.post(`/api/bookings/${bookingId}/employees/${person.id}/deadline`).send({ date: '26/10/2026', reason: 'Was travelling' }).expect(200);
      const link = await openLink().expect(200);
      assert.equal(link.body.window.open, true, 'link opens for the extended traveller');
      const agent = await identify(person);
      await start(agent, 'old_vertical').expect(201);
      await upload(agent, 'front', await jpeg()).expect(201);
      // Others are still locked out.
      const res = await askCode(request.agent(t.app), people['Traveller 3'].id).expect(409);
      assert.match(res.body.message, /deadline/);

      await hospitality.post(`/api/bookings/${bookingId}/deadline`).send({ date: '27/10/2026', reason: 'Hotel agreed' }).expect(200);
      await identify(people['Traveller 3']);
      const [entry] = await t.auditEntries('bookings.deadline.extend').then((rows) => rows.filter((r) => r.outcome === 'success'));
      assert.equal(entry.details.reason, 'Hotel agreed');
      assert.deepEqual(entry.details.changes.deadlineAt, { old: '2026-10-23 23:59:59.999', new: '2026-10-27 23:59:59.999' });
    });

    it('a short-notice booking stays closed until hospitality sets its deadline', async () => {
      const short = await createBooking(coordinator, [employee(30)], bookingBody({ eventName: 'Rush trip', checkInDate: '17/10/2026', checkOutDate: '18/10/2026' }));
      const shortLink = await linkFor(coordinator, short.id);
      assert.match(shortLink.messages.whatsapp, /deadline to be confirmed by hospitality/);
      const res = await openLink(shortLink.token).expect(200);
      assert.equal(res.body.window.reason, 'no_deadline');
      await hospitality.post(`/api/bookings/${short.id}/deadline`).send({ date: '15/10/2026', reason: 'Short notice' }).expect(200);
      assert.equal((await openLink(shortLink.token).expect(200)).body.window.open, true);
      await identify(short.byName['Traveller 30'], shortLink.token);
    });
  });

  // --- G. History and H. no sensitive content in logs ---------------------------------

  describe('history and logs', () => {
    it('booking history lists link opens, identification, uploads and locked attempts for hospitality and admins only', async () => {
      await openLink().expect(200);
      const person = people['Traveller 2'];
      const agent = request.agent(t.app);
      await askCode(agent, person.id).expect(202);
      await sendCode(agent, person.id, '000001' === t.lastCode(person.email) ? '000002' : '000001').expect(401);
      await sendCode(agent, person.id, t.lastCode(person.email)).expect(200);
      await start(agent, 'old_vertical').expect(201);
      await upload(agent, 'front', await jpeg()).expect(201);

      await coordinator.get(`/api/bookings/${bookingId}/history`).expect(403);
      const admin = await t.signIn(ADMIN);
      await admin.get(`/api/bookings/${bookingId}/history`).expect(200);
      const { entries } = (await hospitality.get(`/api/bookings/${bookingId}/history`).expect(200)).body;
      const actions = entries.map((e) => `${e.action}:${e.outcome}`);
      for (const expected of [
        'employee.link.open:success',
        'employee.identify.request_code:success',
        'employee.identify.verify:failure',
        'employee.identify.verify:success',
        'employee.upload:success',
        'employee.submission.submitted:success',
      ]) assert.ok(actions.includes(expected), expected);
      const upload1 = entries.find((e) => e.action === 'employee.upload');
      assert.equal(upload1.actor, 'Traveller 2');
      assert.equal(upload1.actorType, 'employee');
      assert.match(upload1.occurredAt, /\+05:30$/);
    });

    it('no log line or audit entry contains a code, a token, file content or an Aadhaar-like number', async () => {
      const captured = [];
      const originalOut = process.stdout.write;
      const originalErr = process.stderr.write;
      const previousLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'debug';
      // Keep our JSON log lines (and hide them); pass everything else (the test runner) through.
      const tap = (original) => function write(chunk, ...rest) {
        const text = String(chunk);
        if (text.startsWith('{"time":')) {
          captured.push(text);
          return true;
        }
        return original.call(this, chunk, ...rest);
      };
      process.stdout.write = tap(originalOut);
      process.stderr.write = tap(originalErr);
      const codes = [];
      let documentBytes;
      try {
        await openLink().expect(200);
        const person = people['Traveller 2'];
        const agent = request.agent(t.app);
        await askCode(agent, person.id).expect(202);
        codes.push(t.lastCode(person.email));
        await sendCode(agent, person.id, AADHAAR_LIKE_SAMPLE).expect(401);
        await sendCode(agent, person.id, codes[0]).expect(200);
        await start(agent).expect(201);
        // A file whose name, body and text all carry an Aadhaar-shaped number.
        documentBytes = await pdf(1, `Aadhaar ${AADHAAR_LIKE_SAMPLE}`);
        await agent.put('/api/e/submission/files/document').set('Content-Type', 'application/pdf')
          .set('X-File-Name', `aadhaar ${AADHAAR_LIKE_SAMPLE}.pdf`).send(documentBytes).expect(201);
        await start(agent).expect(201);
        await upload(agent, 'front', Buffer.from(`fake ${AADHAAR_LIKE_SAMPLE} ${'y'.repeat(50)}`)).expect(400);
        const url = (await me(agent)).submission.current.files[0].url;
        await fetchFile(agent, url).expect(200);
        await openLink('bad-token').expect(404);
        // A failure deep inside a request still logs nothing sensitive.
        const realRead = t.fileStore.read;
        t.fileStore.read = async () => { throw new Error(`disk error ${AADHAAR_LIKE_SAMPLE} ${codes[0]}`); };
        await fetchFile(agent, (await me(agent)).submission.current.files[0].url).expect(500);
        t.fileStore.read = realRead;
      } finally {
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
        process.env.LOG_LEVEL = previousLevel;
      }

      // Request ids are random UUIDs, which now and then contain digits shaped like an
      // Aadhaar number; they are not data, so they are blanked before the scan.
      const withoutUuids = (text) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
      const logs = withoutUuids(captured.join(''));
      assert.ok(logs.includes('"msg":"request"'), 'logs were captured');
      const audit = withoutUuids(JSON.stringify(await t.dump('audit_log')));
      for (const [name, text] of [['logs', logs], ['audit log', audit]]) {
        assert.doesNotMatch(text, AADHAAR_LIKE, `${name}: Aadhaar-like number`);
        for (const code of codes) assert.ok(!text.includes(code), `${name}: OTP code`);
        assert.ok(!text.includes(token), `${name}: booking link token`);
        assert.ok(!text.includes(documentBytes.subarray(0, 40).toString('base64')), `${name}: file content`);
      }
      assert.ok(!logs.includes('traveller2@example.com'), 'logs: email address');
      // Stored codes are hashes only.
      const otps = await t.dump('employee_otp_codes');
      assert.ok(otps.every((o) => /^[0-9a-f]{64}$/.test(o.codeHash) && !codes.includes(o.codeHash)));
    });
  });

  it('sniffs file types from content, not names', async () => {
    assert.equal(sniffType(await jpeg()), 'jpeg');
    assert.equal(sniffType(await png()), 'png');
    assert.equal(sniffType(heic()), 'heic');
    assert.equal(sniffType(await pdf()), 'pdf');
    assert.equal(sniffType(Buffer.from('GIF89a................')), null);
    assert.equal(sniffType(await sharp(cardSvg(100, 100)).avif().toBuffer()), null, 'AVIF is not accepted');
    assert.equal(sniffType(Buffer.from('short')), null);
  });
});
