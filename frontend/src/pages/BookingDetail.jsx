import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate, formatDateTime } from '../dates.js';
import { Deadline } from './Bookings.jsx';

const EMPTY_EMPLOYEE = { name: '', employeeCode: '', email: '', mobile: '', department: '', zone: '', hq: '', isVacant: false };
const FIELDS = [
  ['name', 'Name'], ['employeeCode', 'Employee code'], ['email', 'Email'], ['mobile', 'Mobile'],
  ['department', 'Department'], ['zone', 'Zone'], ['hq', 'HQ'],
];

function EmployeeForm({ initial, submitLabel, onSubmit, onCancel }) {
  const [form, setForm] = useState(initial);
  return (
    <form className="row-form" onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}>
      {FIELDS.map(([key, label]) => (
        <label key={key}>
          {label}
          <input value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        </label>
      ))}
      <label className="check">
        <input type="checkbox" checked={form.isVacant} onChange={(e) => setForm({ ...form, isVacant: e.target.checked })} />
        Vacant
      </label>
      <button type="submit">{submitLabel}</button>
      {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
    </form>
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or a page not served over HTTPS: fall back to a hidden textarea.
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function CopyButton({ text, label = 'Copy' }) {
  const [state, setState] = useState('');
  return (
    <button type="button" className="secondary" onClick={async () => setState((await copyText(text)) ? 'Copied' : 'Select and copy by hand')}>
      {state || label}
    </button>
  );
}

/** The one booking link, with editable WhatsApp and email texts to copy (C1, C2). */
function SharePanel({ bookingId, window: w }) {
  const [data, setData] = useState(null);
  const [whatsapp, setWhatsapp] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const res = await api(`/bookings/${bookingId}/link`);
      setData(res);
      setWhatsapp(res.messages.whatsapp);
      setSubject(res.messages.email.subject);
      setBody(res.messages.email.body);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Booking link and messages</h2>
      <p className="muted">One link for everyone on this booking. Each person picks their name and confirms with a code sent to their email.</p>
      {!w.open && <p className="notice">Employees opening the link now see: “{w.message}”</p>}
      {!data && <button type="button" onClick={load}>Show link and messages</button>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <div className="stack">
          <label>
            Booking link
            <div className="copy-row">
              <input readOnly value={data.url} onFocus={(e) => e.target.select()} />
              <CopyButton text={data.url} label="Copy link" />
            </div>
          </label>
          <label>
            WhatsApp message (you can edit it before copying)
            <textarea rows={6} value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
          </label>
          <div className="actions"><CopyButton text={whatsapp} label="Copy WhatsApp message" /></div>
          <label>
            Email subject
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            Email message (you can edit it before copying)
            <textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="actions">
            <CopyButton text={subject} label="Copy subject" />
            <CopyButton text={body} label="Copy email message" />
            <button type="button" className="link" onClick={() => { setWhatsapp(data.messages.whatsapp); setSubject(data.messages.email.subject); setBody(data.messages.email.body); }}>
              Reset texts
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Hospitality: set or extend a deadline (booking or one person), with a reason. */
function DeadlineForm({ label, onSave, onCancel }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  return (
    <form className="row-form" onSubmit={(e) => { e.preventDefault(); onSave({ date, reason }); }}>
      <label>
        {label} (DD/MM/YYYY, until 23:59 IST)
        <input value={date} onChange={(e) => setDate(e.target.value)} placeholder="DD/MM/YYYY" inputMode="numeric" />
      </label>
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      <button type="submit" disabled={!date || !reason.trim()}>Save</button>
      {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
    </form>
  );
}

/** One traveller's Aadhaar, through short-lived signed links. */
function AadhaarViewer({ bookingId, employeeId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/bookings/${bookingId}/employees/${employeeId}/files`).then(setData).catch((err) => setError(err.message));
  }, [bookingId, employeeId]);
  return (
    <div className="viewer">
      {error && <p className="error">{error}</p>}
      {data && !data.current && <p className="muted">Nothing on file.</p>}
      {data?.current && (
        <div className="viewer-files">
          {data.current.files.map((f) => (
            <figure key={f.id}>
              {f.mimeType === 'application/pdf'
                ? <a href={f.url} target="_blank" rel="noreferrer">Open PDF ({f.pageCount} page{f.pageCount > 1 ? 's' : ''})</a>
                : <a href={f.url} target="_blank" rel="noreferrer"><img src={f.url} alt={`Aadhaar ${f.side}`} /></a>}
              <figcaption className="muted">{f.side === 'document' ? 'PDF' : f.side} · {formatDateTime(f.uploadedAt)}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <p className="hint">Links expire after 5 minutes; every view is recorded in the booking history.</p>
      <button type="button" className="secondary" onClick={onClose}>Close</button>
    </div>
  );
}

const ACTION_LABELS = {
  'employee.link.open': 'Booking link opened',
  'employee.identify.request_code': 'Employee asked for a code',
  'employee.identify.verify': 'Employee confirmed identity',
  'employee.page.read': 'Employee viewed upload page',
  'employee.submission.start': 'Employee chose card type and consented',
  'employee.upload': 'File uploaded',
  'employee.submission.submitted': 'Aadhaar received',
  'employee.submission.replaced': 'Aadhaar replaced',
  'employee.file.view': 'Employee viewed own file',
  'aadhaar.files.list': 'Aadhaar list opened',
  'aadhaar.file.view': 'Aadhaar file viewed',
  'bookings.deadline.extend': 'Booking deadline changed',
  'bookings.employees.deadline.extend': 'Personal deadline extended',
  'bookings.link.read': 'Booking link copied',
};

function HistoryPanel({ bookingId }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  async function load() {
    try {
      setEntries((await api(`/bookings/${bookingId}/history`)).entries);
    } catch (err) {
      setError(err.message);
    }
  }
  const reason = (e) => e.details?.reason || e.details?.error || '';
  return (
    <section className="card">
      <div className="heading-row">
        <h2>Booking history</h2>
        <button type="button" className="secondary" onClick={load}>{entries ? 'Refresh' : 'Show history'}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {entries && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When (IST)</th><th>Who</th><th>What</th><th>Result</th><th>IP</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.occurredAt)}</td>
                  <td>{e.actor || (e.actorType === 'anonymous' ? 'Visitor (not identified)' : e.actorType)}{e.actorRole ? ` (${e.actorRole})` : ''}</td>
                  <td>{ACTION_LABELS[e.action] || e.action}</td>
                  <td>{e.outcome}{reason(e) ? `: ${reason(e).replace(/_/g, ' ')}` : ''}</td>
                  <td>{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Upload, preview (nothing saved), then confirm. */
function ImportPanel({ bookingId, hasEmployees, onImported }) {
  const [mode, setMode] = useState(hasEmployees ? 'append' : 'replace');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function upload(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setPreview(null);
    const format = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
    setBusy(true);
    try {
      setPreview(await api(`/bookings/${bookingId}/employees/preview?format=${format}&mode=${mode}`, {
        method: 'POST', file, contentType: 'application/octet-stream',
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const rows = preview.rows.map(({ errors, ...row }) => row);
      await api(`/bookings/${bookingId}/employees/import`, { method: 'POST', body: { mode: preview.mode, rows } });
      setPreview(null);
      onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const errorRows = preview?.rows.filter((r) => r.errors.length) ?? [];

  return (
    <div className="panel">
      <h3>Import the employee list</h3>
      <p className="muted">
        Download the template: <a href="/api/bookings/templates/employees.xlsx">Excel (.xlsx)</a> or{' '}
        <a href="/api/bookings/templates/employees.csv">CSV</a>. Nothing is saved until you confirm.
      </p>
      <div className="row-form">
        <label>
          When importing
          <select value={mode} onChange={(e) => { setMode(e.target.value); setPreview(null); }}>
            <option value="replace">Replace the current list</option>
            <option value="append">Add to the current list</option>
          </select>
        </label>
        <label>
          File (.xlsx or .csv)
          <input type="file" accept=".xlsx,.csv" onChange={upload} disabled={busy} />
        </label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {preview && (
        <div>
          <p>
            <strong>{preview.summary.total}</strong> rows: <strong>{preview.summary.active}</strong> active,{' '}
            <strong>{preview.summary.vacant}</strong> vacant.{' '}
            {preview.summary.withErrors
              ? <span className="error-text">{preview.summary.withErrors} row(s) have errors. Fix the file and upload it again.</span>
              : <span>No errors.</span>}
            {preview.mode === 'replace' && preview.currentCount > 0 && (
              <span className="error-text"> Confirming replaces the {preview.currentCount} people currently on the list.</span>
            )}
          </p>
          {preview.ignoredColumns.length > 0 && <p className="muted">Ignored columns: {preview.ignoredColumns.join(', ')}</p>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Row</th><th>Name</th><th>Code</th><th>Email</th><th>Mobile</th><th>Vacant</th><th>Problems</th></tr></thead>
              <tbody>
                {(errorRows.length ? errorRows : preview.rows).slice(0, 200).map((r) => (
                  <tr key={r.rowNumber} className={r.errors.length ? 'has-error' : ''}>
                    <td>{r.rowNumber}</td><td>{r.name}</td><td>{r.employeeCode}</td><td>{r.email}</td><td>{r.mobile}</td>
                    <td>{r.isVacant ? 'Yes' : 'No'}</td><td>{r.errors.join(' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" disabled={busy || preview.summary.withErrors > 0} onClick={confirm}>
            Confirm import of {preview.summary.total} rows
          </button>
          <button type="button" className="secondary" onClick={() => setPreview(null)}>Discard</button>
        </div>
      )}
    </div>
  );
}

export default function BookingDetail({ bookingId, user }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [extending, setExtending] = useState(null); // 'booking' or an employee id

  const load = useCallback(async () => {
    try {
      setData(await api(`/bookings/${bookingId}`));
    } catch (err) {
      setError(err.message);
    }
  }, [bookingId]);

  useEffect(() => { load(); }, [load]);

  async function run(fn, done) {
    setError('');
    setNotice('');
    try {
      await fn();
      await load();
      if (done) setNotice(done);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  function takeAction(a) {
    let note;
    if (a.noteRequired) {
      note = window.prompt(`${a.label}: add a short note explaining why.`);
      if (!note) return;
    } else if (!window.confirm(`${a.label}?`)) return;
    run(() => api(`/bookings/${bookingId}/actions`, { method: 'POST', body: { action: a.action, note } }), `${a.label}: done.`);
  }

  if (!data) return <section className="card">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</section>;

  const { booking, employees, actions, canEdit, canShareLink, canViewAadhaar, canExtendDeadline, uploadWindow } = data;
  const base = `/bookings/${bookingId}/employees`;
  const seesHistory = user && (user.role === 'hospitality' || user.role === 'admin');
  const columns = 11 + (canEdit ? 1 : 0);
  const saveDeadline = (path, label) => (form) => run(() => api(path, { method: 'POST', body: form }), label)
    .then((ok) => ok && setExtending(null));

  return (
    <>
      <section className="card">
        <p><a href="#/bookings">← All bookings</a></p>
        <div className="heading-row">
          <h1>{booking.eventName}</h1>
          <span className="badge">{booking.statusLabel}</span>
          {booking.isShortNotice && <span className="badge warn">Short notice</span>}
        </div>
        <dl className="facts">
          <dt>Hotel</dt><dd>{booking.hotelName}{booking.hotelPending && <span className="badge warn">Pending review</span>}</dd>
          <dt>Travel</dt><dd>{formatDate(booking.checkInDate)} to {formatDate(booking.checkOutDate)}</dd>
          <dt>Location</dt><dd>{booking.location}</dd>
          <dt>Division</dt><dd>{booking.divisionName}</dd>
          <dt>Deadline</dt>
          <dd>
            <Deadline booking={booking} />
            {canExtendDeadline && extending !== 'booking' && (
              <button type="button" className="link" onClick={() => setExtending('booking')}> {booking.deadlineAt ? 'Change' : 'Set deadline'}</button>
            )}
          </dd>
          <dt>Travellers</dt>
          <dd>{booking.counts.active} active · {booking.counts.vacant} vacant · {booking.counts.pending} pending</dd>
          <dt>Created</dt><dd>{booking.createdBy.name}, {formatDateTime(booking.createdAt)}</dd>
          <dt>Last changed</dt><dd>{booking.updatedBy.name}, {formatDateTime(booking.updatedAt)}</dd>
          {booking.cancellationNote && (<><dt>Cancellation note</dt><dd>{booking.cancellationNote}</dd></>)}
        </dl>
        {extending === 'booking' && (
          <DeadlineForm
            label="New booking deadline"
            onSave={saveDeadline(`/bookings/${bookingId}/deadline`, 'Deadline saved.')}
            onCancel={() => setExtending(null)}
          />
        )}
        <div className="actions">
          {canEdit && <a className="button secondary" href={`#/bookings/${bookingId}/edit`}>Edit details</a>}
          {actions.map((a) => (
            <button
              key={a.action}
              type="button"
              className={a.action === 'cancel' ? 'secondary danger' : ''}
              disabled={!a.available}
              title={a.reason || ''}
              onClick={() => takeAction(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
        {actions.filter((a) => !a.available).map((a) => <p key={a.action} className="hint">{a.label}: {a.reason}</p>)}
        {!canEdit && <p className="muted">This booking is read-only for you.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
      </section>

      {canShareLink && <SharePanel bookingId={bookingId} window={uploadWindow} />}

      <section className="card">
        <div className="heading-row">
          <h2>Employees</h2>
          {canEdit && !adding && <button type="button" className="secondary" onClick={() => setAdding(true)}>Add a person</button>}
        </div>
        <p className="muted">Vacant positions count as headcount only: no invitations, reminders or deadlines.</p>

        {adding && (
          <EmployeeForm
            initial={EMPTY_EMPLOYEE}
            submitLabel="Add"
            onSubmit={(form) => run(() => api(base, { method: 'POST', body: form }), 'Added.').then((ok) => ok && setAdding(false))}
            onCancel={() => setAdding(false)}
          />
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Code</th><th>Email</th><th>Mobile</th><th>Department</th><th>Zone</th><th>HQ</th><th>Vacant</th>
                <th>Opened</th><th>Aadhaar</th><th>Personal deadline</th>{canEdit && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 && <tr><td colSpan={columns} className="muted">No employees yet. Import a list below or add people one by one.</td></tr>}
              {employees.map((e) => (editing === e.id ? (
                <tr key={e.id}>
                  <td colSpan={columns}>
                    <EmployeeForm
                      initial={e}
                      submitLabel="Save"
                      onSubmit={(form) => run(() => api(`${base}/${e.id}`, { method: 'PUT', body: form }), 'Saved.').then((ok) => ok && setEditing(null))}
                      onCancel={() => setEditing(null)}
                    />
                  </td>
                </tr>
              ) : [
                <tr key={e.id} className={e.isVacant ? 'inactive' : ''}>
                  <td>{e.name || <span className="muted">(vacant position)</span>}</td>
                  <td>{e.employeeCode}</td><td>{e.email}</td><td>{e.mobile}</td>
                  <td>{e.department}</td><td>{e.zone}</td><td>{e.hq}</td>
                  <td>
                    {canEdit ? (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={e.isVacant}
                          onChange={(ev) => run(() => api(`${base}/${e.id}/vacant`, { method: 'PATCH', body: { isVacant: ev.target.checked } }))}
                        />
                        {e.isVacant ? 'Yes' : 'No'}
                      </label>
                    ) : (e.isVacant ? 'Yes' : 'No')}
                  </td>
                  <td>{e.isVacant ? '' : (e.openedAt ? formatDateTime(e.openedAt) : <span className="muted">Not yet</span>)}</td>
                  <td>
                    {!e.isVacant && (e.submissionStatus === 'submitted'
                      ? <span className="badge">Submitted {formatDate(e.submittedAt)}</span>
                      : <span className="badge warn">Pending</span>)}
                    {!e.isVacant && canViewAadhaar && e.submissionStatus === 'submitted' && (
                      <button type="button" className="link" onClick={() => setViewing(viewing === e.id ? null : e.id)}> View</button>
                    )}
                  </td>
                  <td>
                    {!e.isVacant && (e.deadlineOverrideAt ? formatDateTime(e.deadlineOverrideAt) : <span className="muted">Booking deadline</span>)}
                    {!e.isVacant && canExtendDeadline && (
                      <button type="button" className="link" onClick={() => setExtending(e.id)}> Extend</button>
                    )}
                  </td>
                  {canEdit && (
                    <td className="actions">
                      <button type="button" className="link" onClick={() => setEditing(e.id)}>Edit / replace</button>
                      <button
                        type="button"
                        className="link danger"
                        onClick={() => window.confirm(`Remove ${e.name || e.employeeCode || 'this row'}?${e.submissionStatus === 'submitted' ? ' Their uploaded Aadhaar will be deleted.' : ''}`)
                          && run(() => api(`${base}/${e.id}`, { method: 'DELETE' }), 'Removed.')}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>,
                viewing === e.id && (
                  <tr key={`${e.id}-view`}><td colSpan={columns}><AadhaarViewer bookingId={bookingId} employeeId={e.id} onClose={() => setViewing(null)} /></td></tr>
                ),
                extending === e.id && (
                  <tr key={`${e.id}-extend`}>
                    <td colSpan={columns}>
                      <DeadlineForm
                        label={`Personal deadline for ${e.name}`}
                        onSave={saveDeadline(`${base}/${e.id}/deadline`, 'Personal deadline saved.')}
                        onCancel={() => setExtending(null)}
                      />
                    </td>
                  </tr>
                ),
              ]))}
            </tbody>
          </table>
        </div>

        {canEdit && <ImportPanel key={employees.length > 0 ? 'has-list' : 'empty'} bookingId={bookingId} hasEmployees={employees.length > 0} onImported={() => { setNotice('Employee list imported.'); load(); }} />}
      </section>

      {seesHistory && <HistoryPanel bookingId={bookingId} />}
    </>
  );
}
