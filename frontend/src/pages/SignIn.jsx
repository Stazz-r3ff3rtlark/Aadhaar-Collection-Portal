import { useState } from 'react';
import { api } from '../api.js';

// Internal sign-in: @alembic.co.in email, then an emailed code or a password.
// Field names and autocomplete hints follow the conventions Chrome, Edge and Safari
// use to offer saving and filling the password.

const DOMAIN = '@alembic.co.in';

export default function SignIn({ onSignedIn }) {
  const [step, setStep] = useState('email'); // email | code | password | reset
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function checkDomain() {
    if (!email.trim().toLowerCase().endsWith(DOMAIN)) {
      setError(`Use your ${DOMAIN} email address.`);
      return false;
    }
    return true;
  }

  const sendCode = (purpose) => run(async () => {
    if (!checkDomain()) return;
    const path = purpose === 'reset' ? '/auth/password/reset/request' : '/auth/otp/request';
    const res = await api(path, { method: 'POST', body: { email } });
    setNotice(res.message);
    setStep(purpose === 'reset' ? 'reset' : 'code');
  });

  function back() {
    setStep('email');
    setError('');
    setNotice('');
  }

  return (
    <main className="center">
      <div className="card narrow">
        <h1>Sign in</h1>
        <p className="muted">Aadhaar Collection Portal for Alembic sales coordinators, hospitality and admins.</p>

        {step === 'email' && (
          <form onSubmit={(e) => { e.preventDefault(); if (checkDomain()) setStep('choose'); }}>
            <EmailField email={email} setEmail={setEmail} autoFocus />
            <button type="submit" disabled={busy}>Continue</button>
          </form>
        )}

        {step === 'choose' && (
          <div className="stack">
            <p>Signing in as <strong>{email}</strong></p>
            <button type="button" disabled={busy} onClick={() => sendCode('login')}>Email me a sign-in code</button>
            <button type="button" className="secondary" onClick={() => { setError(''); setStep('password'); }}>Use my password</button>
            <button type="button" className="link" onClick={back}>Use a different email</button>
          </div>
        )}

        {step === 'code' && (
          <form onSubmit={(e) => {
            e.preventDefault();
            const code = new FormData(e.currentTarget).get('code');
            run(async () => {
              const { user } = await api('/auth/otp/verify', { method: 'POST', body: { email, code } });
              onSignedIn(user);
            });
          }}
          >
            {notice && <p className="notice">{notice}</p>}
            <label>
              Six-digit code
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
            </label>
            <button type="submit" disabled={busy}>Sign in</button>
            <button type="button" className="link" disabled={busy} onClick={() => sendCode('login')}>Send a new code</button>
            <button type="button" className="link" onClick={back}>Back</button>
          </form>
        )}

        {step === 'password' && (
          <form
            method="post"
            action="#"
            onSubmit={(e) => {
              e.preventDefault();
              const password = new FormData(e.currentTarget).get('password');
              run(async () => {
                const { user } = await api('/auth/password/login', { method: 'POST', body: { email, password } });
                onSignedIn(user);
              });
            }}
          >
            <EmailField email={email} setEmail={setEmail} />
            <label>
              Password
              <input type="password" name="password" autoComplete="current-password" required autoFocus />
            </label>
            <button type="submit" disabled={busy}>Sign in</button>
            <button type="button" className="link" disabled={busy} onClick={() => sendCode('reset')}>
              Set or reset password
            </button>
            <button type="button" className="link" onClick={back}>Back</button>
          </form>
        )}

        {step === 'reset' && (
          <form
            method="post"
            action="#"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              if (data.get('newPassword') !== data.get('confirmPassword')) {
                setError('The two passwords do not match.');
                return;
              }
              run(async () => {
                const res = await api('/auth/password/reset/confirm', {
                  method: 'POST',
                  body: { email, code: data.get('code'), newPassword: data.get('newPassword') },
                });
                setNotice(res.message);
                setStep('password');
              });
            }}
          >
            {notice && <p className="notice">{notice}</p>}
            <input type="hidden" name="username" autoComplete="username" value={email} readOnly />
            <label>
              Six-digit code
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
            </label>
            <label>
              New password (at least 10 characters)
              <input type="password" name="newPassword" autoComplete="new-password" minLength={10} maxLength={72} required />
            </label>
            <label>
              Confirm new password
              <input type="password" name="confirmPassword" autoComplete="new-password" minLength={10} maxLength={72} required />
            </label>
            <button type="submit" disabled={busy}>Save password</button>
            <button type="button" className="link" onClick={back}>Back</button>
          </form>
        )}

        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>
  );
}

function EmailField({ email, setEmail, autoFocus }) {
  return (
    <label>
      Work email
      <input
        type="email"
        name="username"
        autoComplete="username"
        placeholder={`name${DOMAIN}`}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoFocus={autoFocus}
      />
    </label>
  );
}
