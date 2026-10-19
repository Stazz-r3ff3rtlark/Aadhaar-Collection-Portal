import { formatDateTime } from '../dates.js';
import { ROLE_LABELS } from '../roles.js';

const NEXT_STEPS = {
  coordinator: [['#/bookings', 'See your division’s bookings'], ['#/bookings/new', 'Create a booking']],
  hospitality: [['#/bookings', 'See all bookings'], ['#/hotels', 'Review pending hotels']],
  admin: [['#/admin/users', 'Manage users'], ['#/admin/divisions', 'Manage divisions'], ['#/hotels', 'Manage hotels'], ['#/bookings', 'View bookings']],
  analytics_viewer: [],
};

export default function Home({ user }) {
  return (
    <section className="card">
      <h1>Welcome, {user.name}</h1>
      <p>
        You are signed in as <strong>{ROLE_LABELS[user.role]}</strong>
        {user.divisionName && <> in <strong>{user.divisionName}</strong></>}
        {user.lastLoginAt && <> · signed in {formatDateTime(user.lastLoginAt)}</>}.
      </p>
      <ul>
        {NEXT_STEPS[user.role].map(([href, label]) => <li key={href}><a href={href}>{label}</a></li>)}
      </ul>
      {!user.hasPassword && (
        <p className="muted">
          Tip: to sign in faster next time, sign out and choose &ldquo;Use my password&rdquo;, then &ldquo;Set or reset password&rdquo;.
        </p>
      )}
    </section>
  );
}
