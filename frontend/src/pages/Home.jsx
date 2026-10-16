import { formatDateTime } from '../dates.js';
import { ROLE_LABELS } from '../roles.js';

export default function Home({ user }) {
  return (
    <section className="card">
      <h1>Welcome, {user.name}</h1>
      <p>
        You are signed in as <strong>{ROLE_LABELS[user.role]}</strong>
        {user.lastLoginAt && <> · signed in {formatDateTime(user.lastLoginAt)}</>}.
      </p>
      {!user.hasPassword && (
        <p className="muted">
          Tip: to sign in faster next time, sign out and choose &ldquo;Use my password&rdquo;, then &ldquo;Set or reset password&rdquo;.
        </p>
      )}
      <p className="muted">Bookings and tracking will appear here.</p>
    </section>
  );
}
