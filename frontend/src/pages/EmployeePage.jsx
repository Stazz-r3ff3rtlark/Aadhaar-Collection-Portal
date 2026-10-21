import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatDateTime } from '../dates.js';

// The page behind the shared booking link (#/b/<token>). Mobile first: most employees
// open it on a phone from a WhatsApp group.
//
// Steps: booking details -> pick your name -> code from your email -> Aadhaar guide,
// card type and consent -> upload -> "received". The link token goes to the API in a
// header only, never in a URL the server sees.

const ACCEPT = 'image/jpeg,image/png,image/heic,image/heif,.heic,.heif,application/pdf';
const SIDE_LABELS = { front: 'Front', back: 'Back', document: 'PDF (whole card)' };

function BookingHeader({ booking, window: w }) {
  return (
    <header className="emp-header">
      <p className="muted small">Aadhaar upload</p>
      <h1>{booking.event}</h1>
      <p>{[booking.hotel, booking.city].filter(Boolean).join(', ')} · {booking.location}</p>
      <p>{booking.checkIn} to {booking.checkOut}</p>
      {w?.deadlineAt && <p><strong>Upload by {formatDateTime(w.deadlineAt)}</strong></p>}
    </header>
  );
}

function Closed({ message }) {
  return <div className="emp-closed" role="status">{message}</div>;
}

/**
 * Name search. Nothing is listed until the employee has typed a few characters; the
 * server then returns a handful of matches (name and employee code only).
 */
function NamePicker({ headers, search, onPick }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const ready = query.trim().length >= search.minChars;

  useEffect(() => {
    if (!ready) {
      setResult(null);
      return undefined;
    }
    let current = true;
    // Wait for a pause in typing before asking the server.
    const timer = setTimeout(async () => {
      try {
        const res = await api('/e/people/search', { method: 'POST', body: { q: query }, headers });
        if (current) { setResult(res); setError(''); }
      } catch (err) {
        if (current) setError(err.message);
      }
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [query, ready, headers]);

  return (
    <div className="stack">
      <h2>Find your name</h2>
      <label>
        Type your name or employee code
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" autoFocus placeholder="e.g. Priya" />
      </label>
      {!ready && <p className="muted small">Type at least {search.minChars} letters of your name, or your employee code.</p>}
      {ready && result && (
        <ul className="emp-names" role="listbox" aria-label="Matching names">
          {result.people.map((p) => (
            <li key={p.id}>
              <button type="button" className="emp-name" onClick={() => onPick(p)}>
                <span>{p.name}</span><span className="muted small">{p.employeeCode}</span>
              </button>
            </li>
          ))}
          {result.people.length === 0 && <li className="muted">No match. Check the spelling, or contact your coordinator if your name is missing.</li>}
          {result.more && <li className="muted small">More people match. Keep typing to narrow it down.</li>}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function CodeStep({ person, headers, onVerified, onBack }) {
  const [sent, setSent] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const request = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      const res = await api('/e/identify/request', { method: 'POST', body: { employeeId: person.id }, headers });
      setSent(res.message);
      setWait(res.retryInSeconds || 60);
    } catch (err) {
      setError(err.message);
      if (err.body?.retryInSeconds) setWait(err.body.retryInSeconds);
      if (err.body?.maskedEmail) setSent(`A code was sent to your registered email ${err.body.maskedEmail}.`);
    } finally {
      setBusy(false);
    }
  }, [person.id, headers]);

  async function verify(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/e/identify/verify', { method: 'POST', body: { employeeId: person.id, code }, headers });
      onVerified();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h2>Is this you?</h2>
      <p className="emp-picked"><strong>{person.name}</strong> <span className="muted small">{person.employeeCode}</span></p>
      {!sent && (
        <>
          <p>We will email a 6-digit code to the address on the booking list.</p>
          <button type="button" onClick={request} disabled={busy}>Send me a code</button>
        </>
      )}
      {sent && (
        <form onSubmit={verify} className="stack">
          <p className="notice">{sent}</p>
          <label>
            Enter the 6-digit code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="emp-code"
              autoFocus
            />
          </label>
          <button type="submit" disabled={busy || code.length !== 6}>Confirm</button>
          <button type="button" className="secondary" onClick={request} disabled={busy || wait > 0}>
            {wait > 0 ? `Send a new code (${wait}s)` : 'Send a new code'}
          </button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="link" onClick={onBack}>Not you? Pick another name</button>
    </div>
  );
}

function Guide() {
  return (
    <div className="emp-guide">
      <h2>Before you upload</h2>
      <ul>
        <li><strong>PVC card</strong> (the plastic card): upload the <strong>front and back</strong>.</li>
        <li><strong>Old paper or vertical card</strong>: upload the <strong>front only</strong>.</li>
        <li>A photo (JPG, PNG or HEIC from an iPhone) or a PDF, up to 10 MB. A PDF can show both sides.</li>
        <li>Lay the card flat in good light. All text must be readable, with no glare and nothing cut off.</li>
      </ul>
    </div>
  );
}

function FilePreview({ file }) {
  if (file.mimeType === 'application/pdf') {
    return (
      <a className="emp-pdf" href={file.url} target="_blank" rel="noreferrer">
        PDF{file.pageCount ? `, ${file.pageCount} page${file.pageCount > 1 ? 's' : ''}` : ''}: tap to view
      </a>
    );
  }
  return <img className="emp-thumb" src={file.url} alt={`${SIDE_LABELS[file.side]} of your card`} />;
}

function Slot({ side, label, file, onFile, busy, maxBytes }) {
  const [error, setError] = useState('');
  function pick(e) {
    const chosen = e.target.files[0];
    e.target.value = '';
    if (!chosen) return;
    if (chosen.size > maxBytes) {
      setError(`This file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. Take a new photo or choose a smaller file.`);
      return;
    }
    setError('');
    onFile(side, chosen).catch((err) => setError(err.message));
  }
  return (
    <div className={`emp-slot${file ? ' done' : ''}`}>
      <div className="emp-slot-head">
        <strong>{label}</strong>
        {file && <span className="badge">Uploaded</span>}
      </div>
      {file && <FilePreview file={file} />}
      <label className="button-like">
        {file ? 'Replace' : 'Choose photo or PDF'}
        <input type="file" accept={ACCEPT} onChange={pick} disabled={busy} hidden />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Received({ current }) {
  return (
    <div className="emp-received" role="status">
      <h2>Received ✓</h2>
      <p>Your Aadhaar is on file for this booking{current.submittedAt ? ` (${formatDateTime(current.submittedAt)})` : ''}. You do not need to do anything else.</p>
      <div className="emp-files">
        {current.files.map((f) => (
          <figure key={f.id}>
            <FilePreview file={f} />
            <figcaption className="muted small">{SIDE_LABELS[f.side]}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function UploadStep({ page, headers, reload, onSignOut }) {
  const { submission, window: w } = page;
  const [cardType, setCardType] = useState(submission.draft?.cardType || '');
  const [consent, setConsent] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function startSubmission(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/e/submission', { method: 'POST', body: { cardType, consent, consentVersion: page.consent.version }, headers });
      setReplacing(false);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendFile(side, file) {
    setBusy(true);
    try {
      await api(`/e/submission/files/${side}`, { method: 'PUT', file, contentType: 'application/octet-stream', headers });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const draft = submission.draft;
  const showStart = w.open && (!draft || replacing) && (submission.status !== 'submitted' || replacing);

  return (
    <div className="stack">
      <p className="muted small">Signed in as <strong>{page.employee.name}</strong> ({page.employee.maskedEmail}) · <button type="button" className="link" onClick={onSignOut}>Not you?</button></p>

      {submission.current && !draft && <Received current={submission.current} />}
      {!w.open && <Closed message={w.message} />}

      {w.open && submission.current && !draft && !replacing && (
        <button type="button" className="secondary" onClick={() => setReplacing(true)}>Replace my upload</button>
      )}

      {showStart && (
        <form onSubmit={startSubmission} className="stack">
          <Guide />
          <fieldset className="emp-cards">
            <legend>Which card do you have?</legend>
            {page.cardTypes.map((c) => (
              <label key={c.key} className={`emp-card${cardType === c.key ? ' selected' : ''}`}>
                <input type="radio" name="cardType" value={c.key} checked={cardType === c.key} onChange={() => setCardType(c.key)} />
                <span><strong>{c.label}</strong><br /><span className="muted small">{c.sides.length === 2 ? 'Front and back' : 'Front only'}</span></span>
              </label>
            ))}
          </fieldset>
          <label className="check emp-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{page.consent.text}</span>
          </label>
          <button type="submit" disabled={busy || !cardType || !consent}>Continue to upload</button>
          {replacing && <button type="button" className="link" onClick={() => setReplacing(false)}>Keep my current upload</button>}
        </form>
      )}

      {w.open && draft && !replacing && (
        <div className="stack">
          <h2>{draft.cardType === 'pvc' ? 'Upload the front and back' : 'Upload the front'}</h2>
          {submission.current && <p className="muted small">Your earlier upload stays on file until this one is complete.</p>}
          {(() => {
            const bySide = Object.fromEntries(draft.files.map((f) => [f.side, f]));
            if (bySide.document) {
              return <Slot side="document" label={SIDE_LABELS.document} file={bySide.document} onFile={sendFile} busy={busy} maxBytes={page.maxBytes} />;
            }
            return draft.requiredSides.map((side) => (
              <Slot key={side} side={side} label={SIDE_LABELS[side]} file={bySide[side]} onFile={sendFile} busy={busy} maxBytes={page.maxBytes} />
            ));
          })()}
          {draft.cardType === 'pvc' && !draft.files.some((f) => f.side === 'document') && (
            <Slot side="document" label="Or one PDF with both sides" file={null} onFile={sendFile} busy={busy} maxBytes={page.maxBytes} />
          )}
          {busy && <p className="muted" role="status">Uploading… please keep this page open.</p>}
          <button type="button" className="link" onClick={() => setReplacing(true)}>Change card type</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export default function EmployeePage({ token }) {
  const headers = useMemo(() => ({ 'X-Link-Token': token }), [token]);
  const [link, setLink] = useState(null);
  const [page, setPage] = useState(null);
  const [person, setPerson] = useState(null);
  const [error, setError] = useState('');

  const loadPage = useCallback(async () => {
    try {
      setPage(await api('/e/me', { headers }));
      return true;
    } catch (err) {
      if (err.status !== 401) setError(err.message);
      setPage(null);
      return false;
    }
  }, [headers]);

  useEffect(() => {
    (async () => {
      try {
        setLink(await api('/e/link', { headers }));
        await loadPage();
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [headers, loadPage]);

  async function signOut() {
    await api('/e/logout', { method: 'POST', headers }).catch(() => {});
    setPage(null);
    setPerson(null);
  }

  let body;
  if (error && !link) body = <Closed message={error} />;
  else if (!link) body = <p className="muted">Loading…</p>;
  else if (page) body = <UploadStep page={page} headers={headers} reload={loadPage} onSignOut={signOut} />;
  else if (!link.window.open) body = <Closed message={link.window.message} />;
  else if (person) body = <CodeStep person={person} headers={headers} onVerified={loadPage} onBack={() => setPerson(null)} />;
  else body = <NamePicker headers={headers} search={link.search} onPick={setPerson} />;

  return (
    <main className="emp">
      <div className="emp-card-wrap">
        {link && <BookingHeader booking={page?.booking || link.booking} window={page?.window || link.window} />}
        {body}
        {error && link && <p className="error" role="alert">{error}</p>}
      </div>
      <p className="muted small emp-foot">Your Aadhaar is used only for hotel check-in and deleted after the trip.</p>
    </main>
  );
}
