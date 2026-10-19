import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate, formatDateTime } from '../dates.js';

const STATUS_OPTIONS = [
  ['', 'All statuses'], ['draft', 'Draft'], ['collecting', 'Collecting'], ['finalised', 'Finalised'],
  ['with_hospitality', 'With hospitality'], ['shared_with_hotel', 'Shared with hotel'], ['completed', 'Completed'],
  ['files_deleted', 'Files deleted'], ['cancelled', 'Cancelled'],
];

export function Deadline({ booking }) {
  if (booking.isShortNotice && !booking.deadlineAt) return <span className="badge warn">Short notice: hospitality sets the deadline</span>;
  return <>{formatDateTime(booking.deadlineAt)}</>;
}

export default function Bookings({ user }) {
  const [bookings, setBookings] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [filters, setFilters] = useState({ status: '', divisionId: '' });
  const [error, setError] = useState('');
  const seesAllDivisions = user.role !== 'coordinator';

  useEffect(() => {
    if (seesAllDivisions) api('/divisions?includeArchived=1').then((d) => setDivisions(d.divisions)).catch(() => {});
  }, [seesAllDivisions]);

  useEffect(() => {
    const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    api(`/bookings${query ? `?${query}` : ''}`)
      .then((res) => { setBookings(res.bookings); setError(''); })
      .catch((err) => setError(err.message));
  }, [filters]);

  return (
    <section className="card">
      <div className="heading-row">
        <h1>Bookings</h1>
        {user.role === 'coordinator' && <a className="button" href="#/bookings/new">New booking</a>}
      </div>
      <p className="muted">
        {user.role === 'coordinator'
          ? 'Bookings of your division, including your colleagues’.'
          : 'Bookings of every division.'}
      </p>

      <div className="row-form">
        <label>
          Status
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {seesAllDivisions && (
          <label>
            Division
            <select value={filters.divisionId} onChange={(e) => setFilters({ ...filters, divisionId: e.target.value })}>
              <option value="">All divisions</option>
              {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Event</th><th>Hotel</th><th>Check-in</th><th>Check-out</th><th>Division</th>
              <th>Status</th><th>Deadline</th><th>Travellers</th><th>Vacant</th><th>Last changed by</th>
            </tr>
          </thead>
          <tbody>
            {bookings.length === 0 && <tr><td colSpan={10} className="muted">No bookings yet.</td></tr>}
            {bookings.map((b) => (
              <tr key={b.id}>
                <td><a href={`#/bookings/${b.id}`}>{b.eventName}</a></td>
                <td>{b.hotelName}{b.hotelPending && <span className="badge warn">Pending</span>}</td>
                <td>{formatDate(b.checkInDate)}</td>
                <td>{formatDate(b.checkOutDate)}</td>
                <td>{b.divisionName}</td>
                <td>{b.statusLabel}</td>
                <td><Deadline booking={b} /></td>
                <td>{b.counts.active}</td>
                <td>{b.counts.vacant}</td>
                <td>{b.updatedBy.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
