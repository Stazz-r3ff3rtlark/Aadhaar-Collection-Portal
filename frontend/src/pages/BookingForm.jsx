import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate } from '../dates.js';

// Create or edit a booking's travel details. Dates are typed as DD/MM/YYYY (a text field,
// so every browser shows the same format). The hotel is picked from the list, or typed;
// a new name becomes a pending hotel for admin or hospitality to complete.

const EMPTY = { hotelName: '', eventName: '', location: '', checkInDate: '', checkOutDate: '' };

export default function BookingForm({ bookingId }) {
  const [form, setForm] = useState(EMPTY);
  const [hotels, setHotels] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!bookingId);

  useEffect(() => {
    api('/hotels').then((res) => setHotels(res.hotels)).catch(() => {});
    if (bookingId) {
      api(`/bookings/${bookingId}`)
        .then(({ booking }) => {
          setForm({
            hotelName: booking.hotelName,
            eventName: booking.eventName,
            location: booking.location,
            checkInDate: formatDate(booking.checkInDate),
            checkOutDate: formatDate(booking.checkOutDate),
          });
          setLoaded(true);
        })
        .catch((err) => setError(err.message));
    }
  }, [bookingId]);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const match = hotels.find((h) => h.name.toLowerCase() === form.hotelName.trim().toLowerCase());

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      eventName: form.eventName,
      location: form.location,
      checkInDate: form.checkInDate,
      checkOutDate: form.checkOutDate,
      ...(match ? { hotelId: match.id } : { hotelName: form.hotelName }),
    };
    try {
      const res = bookingId
        ? await api(`/bookings/${bookingId}`, { method: 'PATCH', body })
        : await api('/bookings', { method: 'POST', body });
      window.location.hash = `#/bookings/${res.booking.id}`;
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <section className="card">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</section>;

  return (
    <section className="card narrow-card">
      <h1>{bookingId ? 'Edit booking' : 'New booking'}</h1>
      <form onSubmit={submit}>
        <label>
          Hotel
          <input list="hotel-list" value={form.hotelName} onChange={set('hotelName')} required maxLength={200} placeholder="Pick from the list or type a new name" />
          <datalist id="hotel-list">
            {hotels.map((h) => <option key={h.id} value={h.name}>{h.city || ''}</option>)}
          </datalist>
          {form.hotelName.trim() && !match && (
            <span className="hint">New hotel: it will be added as pending for admin or hospitality to complete.</span>
          )}
        </label>
        <div className="two-col">
          <label>
            Check-in (DD/MM/YYYY)
            <input value={form.checkInDate} onChange={set('checkInDate')} required placeholder="30/10/2026" inputMode="numeric" pattern="\d{1,2}/\d{1,2}/\d{4}" />
          </label>
          <label>
            Check-out (DD/MM/YYYY)
            <input value={form.checkOutDate} onChange={set('checkOutDate')} required placeholder="01/11/2026" inputMode="numeric" pattern="\d{1,2}/\d{1,2}/\d{4}" />
          </label>
        </div>
        <label>
          Event name
          <input value={form.eventName} onChange={set('eventName')} required maxLength={200} />
        </label>
        <label>
          Location
          <input value={form.location} onChange={set('location')} required maxLength={200} />
        </label>
        <p className="hint">
          The deadline is 23:59 IST, 7 days before check-in. A booking made fewer than 7 days before check-in is
          flagged as short notice, and hospitality sets its deadline.
        </p>
        <button type="submit" disabled={busy}>{bookingId ? 'Save changes' : 'Create booking'}</button>
        <a href={bookingId ? `#/bookings/${bookingId}` : '#/bookings'}>Cancel</a>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </section>
  );
}
