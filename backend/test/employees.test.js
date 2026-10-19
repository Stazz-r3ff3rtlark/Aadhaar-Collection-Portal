'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildTestApp, bookingBody, employee, importEmployees, DIVISIONS } = require('./helpers');
const { validateRows, normaliseMobile, columnForHeader } = require('../src/bookings/employee-rows');

const HEADER = ['Name', 'Employee code', 'Email', 'Mobile', 'Department', 'Zone', 'HQ', 'Vacant (yes or no)'];

const csv = (rows) => Buffer.from([HEADER, ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n'));

async function xlsx(rows, header = HEADER) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Employees');
  sheet.addRow(header);
  for (const r of rows) sheet.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('employee rows (rules)', () => {
  it('accepts common ways of writing an Indian mobile and stores 10 digits', () => {
    for (const value of ['9876543210', '+91 98765 43210', '91-9876543210', '09876543210', '(987) 654-3210']) {
      assert.equal(normaliseMobile(value), '9876543210', value);
    }
    for (const value of ['12345', '5876543210', '98765432101', 'abc']) {
      assert.equal(normaliseMobile(value), null, value);
    }
  });

  it('matches template headers and common variants', () => {
    assert.equal(columnForHeader('Vacant (yes or no)'), 'vacant');
    assert.equal(columnForHeader(' EMP CODE* '), 'employeeCode');
    assert.equal(columnForHeader('Email ID'), 'email');
    assert.equal(columnForHeader('Headquarters'), 'hq');
    assert.equal(columnForHeader('Shoe size'), null);
  });

  it('lets vacant rows leave name, email and mobile blank, and counts them apart', () => {
    const { rows, summary } = validateRows([
      employee(1),
      { employeeCode: 'V1', vacant: 'yes' },
      { vacant: 'Yes' },
      employee(2, { isVacant: undefined, vacant: '' }),
    ]);
    assert.deepEqual(rows.map((r) => r.errors), [[], [], [], []]);
    assert.deepEqual(summary, { total: 4, active: 2, vacant: 2, withErrors: 0 });
  });
});

describe('employee list (HTTP)', () => {
  let t;
  let coordinator;
  let bookingId;
  const COORDINATOR = 'asha@alembic.co.in';
  const HOSPITALITY = 'hosp@alembic.co.in';

  beforeEach(async () => {
    t = await buildTestApp();
    await t.seedUser({ email: COORDINATOR, name: 'Asha', role: 'coordinator', divisionId: DIVISIONS.MEGACARE });
    await t.seedUser({ email: HOSPITALITY, name: 'Hosp', role: 'hospitality' });
    coordinator = await t.signIn(COORDINATOR);
    bookingId = (await coordinator.post('/api/bookings').send(bookingBody()).expect(201)).body.booking.id;
  });
  afterEach(() => t.close());

  const preview = (buffer, format = 'xlsx', mode = 'replace', agent = coordinator) => agent
    .post(`/api/bookings/${bookingId}/employees/preview?format=${format}&mode=${mode}`)
    .set('Content-Type', 'application/octet-stream')
    .send(buffer);

  const detail = async (agent = coordinator) => (await agent.get(`/api/bookings/${bookingId}`).expect(200)).body;

  describe('template', () => {
    it('downloads as xlsx with the expected columns and a yes/no Vacant list', async () => {
      const res = await coordinator.get('/api/bookings/templates/employees.xlsx')
        .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); })
        .expect(200);
      assert.match(res.headers['content-disposition'], /employee-list-template\.xlsx/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body);
      const sheet = wb.getWorksheet('Employees');
      assert.deepEqual(sheet.getRow(1).values.slice(1), HEADER);
      assert.deepEqual(sheet.getCell('H2').dataValidation.formulae, ['"yes,no"']);
      assert.ok(wb.getWorksheet('Instructions'));
      const [entry] = await t.auditEntries('bookings.template.download');
      assert.equal(entry.details.format, 'xlsx');
    });

    it('downloads as csv with the same header', async () => {
      const res = await coordinator.get('/api/bookings/templates/employees.csv').expect(200);
      assert.match(res.headers['content-type'], /text\/csv/);
      assert.equal(res.text.replace(/^﻿/, '').trim(), HEADER.join(','));
    });

    it('a filled-in template imports cleanly', async () => {
      const res = await coordinator.get('/api/bookings/templates/employees.xlsx')
        .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body);
      wb.getWorksheet('Employees').getRow(2).values = ['Meera Shah', 'E0042', 'meera@example.com', '9876500042', 'Sales', 'West', 'Pune', 'no'];
      const filled = Buffer.from(await wb.xlsx.writeBuffer());
      const result = (await preview(filled).expect(200)).body;
      assert.deepEqual(result.summary, { total: 1, active: 1, vacant: 0, withErrors: 0 });
    });
  });

  describe('import errors', () => {
    const problemRows = [
      ['Meera Shah', 'E1', 'meera@example.com', '9876500001', 'Sales', 'West', 'Pune', 'no'], // row 2: ok
      ['Arjun Rao', 'E1', 'arjun@example.com', '9876500002', '', '', '', ''], //               row 3: duplicate code
      ['Kiran Das', 'E3', 'MEERA@example.com', '9876500003', '', '', '', ''], //              row 4: duplicate email
      ['Bad Email', 'E4', 'not-an-email', '9876500004', '', '', '', ''], //                    row 5: bad email
      ['Bad Mobile', 'E5', 'bm@example.com', '12345', '', '', '', ''], //                       row 6: bad mobile
      ['No Email', 'E6', '', '9876500006', '', '', '', 'no'], //                               row 7: missing email, not vacant
      ['', 'V1', '', '', '', '', '', 'yes'], //                                               row 8: vacant, blanks allowed
      ['Odd Vacant', 'E8', 'ov@example.com', '9876500008', '', '', '', 'maybe'], //            row 9: bad vacant value
    ];

    const errorsByRow = (body) => Object.fromEntries(body.rows.map((r) => [r.rowNumber, r.errors.join(' ')]));

    for (const format of ['xlsx', 'csv']) {
      it(`reports each problem on its own row (${format})`, async () => {
        const buffer = format === 'csv' ? csv(problemRows) : await xlsx(problemRows);
        const body = (await preview(buffer, format).expect(200)).body;
        const errors = errorsByRow(body);
        assert.match(errors[2], /Duplicate employee code "E1" \(also on row 3\)/);
        assert.match(errors[3], /Duplicate employee code "E1" \(also on row 2\)/);
        assert.match(errors[2], /Duplicate email "meera@example.com" \(also on row 4\)/);
        assert.match(errors[4], /Duplicate email/);
        assert.match(errors[5], /not a valid email address/);
        assert.match(errors[6], /not a valid 10-digit Indian mobile/);
        assert.match(errors[7], /Email is missing/);
        assert.equal(errors[8], '', 'vacant row with blanks is fine');
        assert.match(errors[9], /Vacant must be yes, no or blank/);
        assert.deepEqual(body.summary, { total: 8, active: 7, vacant: 1, withErrors: 7 });
      });
    }

    it('flags missing required values on non-vacant rows', async () => {
      const body = (await preview(await xlsx([['', '', '', '', '', '', '', '']].concat([['A', 'E1', 'a@example.com', '', '', '', '', '']])))).body;
      assert.equal(body.rows.length, 1, 'fully blank rows are skipped');
      assert.match(body.rows[0].errors.join(' '), /Mobile is missing/);
    });

    it('saves nothing at preview, even for a clean file', async () => {
      await preview(await xlsx([['Meera Shah', 'E1', 'meera@example.com', '9876500001', '', '', '', '']])).expect(200);
      assert.equal((await detail()).employees.length, 0);
      const [entry] = await t.auditEntries('bookings.employees.import_preview');
      assert.deepEqual(entry.details.summary, { total: 1, active: 1, vacant: 0, withErrors: 0 });
      assert.ok(!JSON.stringify(entry).includes('meera@example.com'), 'the audit entry holds counts, not the list');
    });

    it('refuses to save rows with errors and saves nothing', async () => {
      const res = await importEmployees(coordinator, bookingId, [employee(1), employee(2, { employeeCode: 'E0001' })]);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_rows');
      assert.equal((await detail()).employees.length, 0);
    });

    it('explains files it cannot use', async () => {
      const cases = [
        [await xlsx([['x']], ['Full name', 'Department']), /missing: Employee code, Email, Mobile/],
        [Buffer.from('this is not a spreadsheet'), /not a valid .xlsx file/],
        [await xlsx([]), /no employees/],
        [Buffer.alloc(0), /empty/],
      ];
      for (const [buffer, pattern] of cases) {
        const res = await preview(buffer);
        assert.equal(res.status, 400);
        assert.match(res.body.message, pattern);
      }
    });

    it('reads CSV quoting, a BOM and email hyperlinks in xlsx', async () => {
      const csvBody = (await preview(Buffer.concat([
        Buffer.from('﻿'),
        csv([['Shah, Meera "M"', 'E1', 'meera@example.com', '+91 98765 00001', '', '', '', '']]),
      ]), 'csv').expect(200)).body;
      assert.equal(csvBody.rows[0].name, 'Shah, Meera "M"');
      assert.equal(csvBody.rows[0].mobile, '9876500001');

      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet('Employees');
      sheet.addRow(HEADER);
      sheet.addRow(['Meera', 'E1', { text: 'meera@example.com', hyperlink: 'mailto:meera@example.com' }, 9876500001, '', '', '', '']);
      const xlsxBody = (await preview(Buffer.from(await wb.xlsx.writeBuffer())).expect(200)).body;
      assert.equal(xlsxBody.rows[0].email, 'meera@example.com');
      assert.equal(xlsxBody.rows[0].mobile, '9876500001');
      assert.deepEqual(xlsxBody.rows[0].errors, []);
    });

    it('in "add to list" mode, flags codes and emails already on the booking', async () => {
      await importEmployees(coordinator, bookingId, [employee(1)]).expect(201);
      const body = (await preview(await xlsx([
        ['Someone', 'E0001', 'new@example.com', '9876500009', '', '', '', ''],
        ['Other', 'E0099', 'traveller1@example.com', '9876500010', '', '', '', ''],
      ]), 'xlsx', 'append').expect(200)).body;
      assert.match(body.rows[0].errors.join(' '), /Employee code "E0001" is already on this booking/);
      assert.match(body.rows[1].errors.join(' '), /Email "traveller1@example.com" is already on this booking/);
    });
  });

  describe('confirm import', () => {
    it('saves the previewed rows, records who changed the booking, and replaces the list in replace mode', async () => {
      const res = await importEmployees(coordinator, bookingId, [employee(1), employee(2), employee(3, { isVacant: true })]).expect(201);
      assert.deepEqual(res.body.summary, { total: 3, active: 2, vacant: 1, withErrors: 0 });
      const replaced = await importEmployees(coordinator, bookingId, [employee(4)]).expect(201);
      assert.equal(replaced.body.removed, 3);
      const { employees, booking } = await detail();
      assert.deepEqual(employees.map((e) => e.employeeCode), ['E0004']);
      assert.equal(booking.updatedBy.name, 'Asha');
      const entries = await t.auditEntries('bookings.employees.import');
      assert.deepEqual(entries.map((e) => [e.details.mode, e.details.removed]), [['replace', 0], ['replace', 3]]);
    });

    it('adds to the list in append mode', async () => {
      await importEmployees(coordinator, bookingId, [employee(1)]).expect(201);
      await importEmployees(coordinator, bookingId, [employee(2)], 'append').expect(201);
      assert.equal((await detail()).employees.length, 2);
    });
  });

  describe('add, replace and remove', () => {
    it('adds one person with the same checks as the import', async () => {
      await importEmployees(coordinator, bookingId, [employee(1)]).expect(201);
      const dup = await coordinator.post(`/api/bookings/${bookingId}/employees`).send(employee(2, { email: 'traveller1@example.com' }));
      assert.equal(dup.status, 400);
      const ok = await coordinator.post(`/api/bookings/${bookingId}/employees`).send(employee(2)).expect(201);
      assert.equal(ok.body.employee.mobile, '9876500002');
      const [entry] = (await t.auditEntries('bookings.employees.add')).filter((e) => e.outcome === 'success');
      assert.equal(entry.details.new.employeeCode, 'E0002');
    });

    it('replaces a person and records old and new values', async () => {
      await importEmployees(coordinator, bookingId, [employee(1), employee(2)]).expect(201);
      const { employees } = await detail();
      const target = employees.find((e) => e.employeeCode === 'E0001');
      const clash = await coordinator.put(`/api/bookings/${bookingId}/employees/${target.id}`).send(employee(2));
      assert.equal(clash.status, 400, 'cannot take another row\'s code');
      const res = await coordinator.put(`/api/bookings/${bookingId}/employees/${target.id}`)
        .send(employee(9, { name: 'Replacement Person' })).expect(200);
      assert.equal(res.body.employee.employeeCode, 'E0009');
      const [entry] = (await t.auditEntries('bookings.employees.replace')).filter((e) => e.outcome === 'success');
      assert.deepEqual(entry.details.changes.name, { old: 'Traveller 1', new: 'Replacement Person' });
      assert.equal(entry.details.newPerson, true);
    });

    it('removes a person', async () => {
      await importEmployees(coordinator, bookingId, [employee(1), employee(2)]).expect(201);
      const target = (await detail()).employees[0];
      await coordinator.delete(`/api/bookings/${bookingId}/employees/${target.id}`).expect(204);
      assert.equal((await detail()).employees.length, 1);
      const [entry] = await t.auditEntries('bookings.employees.remove');
      assert.equal(entry.details.old.employeeCode, target.employeeCode);
    });

    it('coordinators cannot change employees after finalise; hospitality can', async () => {
      await importEmployees(coordinator, bookingId, [employee(1)]).expect(201);
      await t.query("UPDATE bookings SET status = 'finalised' WHERE id = ?", [bookingId]);
      await coordinator.post(`/api/bookings/${bookingId}/employees`).send(employee(2)).expect(403);
      await importEmployees(coordinator, bookingId, [employee(2)], 'append').expect(403);
      const hosp = await t.signIn(HOSPITALITY);
      await hosp.post(`/api/bookings/${bookingId}/employees`).send(employee(2)).expect(201);
    });
  });

  describe('vacant positions', () => {
    it('are excluded from active and pending counts and from the active traveller list', async () => {
      await importEmployees(coordinator, bookingId, [
        employee(1), employee(2),
        employee(3, { isVacant: true }), { employeeCode: 'V2', isVacant: true },
      ]).expect(201);
      const { booking } = await detail();
      assert.deepEqual(booking.counts, { total: 4, active: 2, vacant: 2, cancelled: 0, pending: 2 });

      const active = await t.store.transaction((tx) => tx.employees.listActive(bookingId));
      assert.deepEqual(active.map((e) => e.employeeCode).sort(), ['E0001', 'E0002']);

      const listed = (await coordinator.get('/api/bookings')).body.bookings[0];
      assert.deepEqual(listed.counts, booking.counts);
    });

    it('can be flipped by coordinators until finalise, and by hospitality at any time', async () => {
      await importEmployees(coordinator, bookingId, [employee(1), employee(2)]).expect(201);
      const target = (await detail()).employees[0];
      const flip = (agent, isVacant) => agent.patch(`/api/bookings/${bookingId}/employees/${target.id}/vacant`).send({ isVacant });

      await flip(coordinator, true).expect(200);
      assert.equal((await detail()).booking.counts.pending, 1);
      await flip(coordinator, false).expect(200);

      await t.query("UPDATE bookings SET status = 'finalised' WHERE id = ?", [bookingId]);
      await flip(coordinator, true).expect(403);
      const hosp = await t.signIn(HOSPITALITY);
      await flip(hosp, true).expect(200);

      const entries = await t.auditEntries('bookings.employees.vacant');
      const done = entries.filter((e) => e.outcome === 'success');
      assert.deepEqual(done.map((e) => e.details.changes.isVacant.new), [true, false, true]);
      assert.equal(done[2].actorEmail, HOSPITALITY);
    });

    it('a vacant row with blanks cannot become active until it is filled in', async () => {
      await importEmployees(coordinator, bookingId, [{ employeeCode: 'V1', isVacant: true }]).expect(201);
      const target = (await detail()).employees[0];
      const res = await coordinator.patch(`/api/bookings/${bookingId}/employees/${target.id}/vacant`).send({ isVacant: false });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /Name is missing.*Email is missing/);
      await coordinator.put(`/api/bookings/${bookingId}/employees/${target.id}`)
        .send(employee(5, { employeeCode: 'V1', isVacant: false })).expect(200);
      assert.equal((await detail()).booking.counts.active, 1);
    });
  });
});
