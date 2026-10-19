import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Admin and hospitality: the hotel list. Names typed by coordinators arrive as "pending";
// complete them, or merge a duplicate into the right hotel (its bookings move over).

export default function Hotels() {
  const [hotels, setHotels] = useState([]);
  const [form, setForm] = useState({ name: '', city: '' });
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', city: '' });
  const [merging, setMerging] = useState(null);
  const [mergeInto, setMergeInto] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      setHotels((await api('/hotels')).hotels);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function run(fn, done) {
    setError('');
    setNotice('');
    try {
      const res = await fn();
      await load();
      setNotice(typeof done === 'function' ? done(res) : done);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  return (
    <section className="card">
      <h1>Hotels</h1>
      <p className="muted">Pending hotels were typed in by a coordinator. Complete them, or merge duplicates into the right hotel.</p>

      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api('/hotels', { method: 'POST', body: form }), `${form.name} added.`).then((ok) => ok && setForm({ name: '', city: '' }));
        }}
      >
        <label>Hotel name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} /></label>
        <label>City<input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} maxLength={100} /></label>
        <button type="submit">Add hotel</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>City</th><th>Status</th><th>Bookings</th><th>Actions</th></tr></thead>
          <tbody>
            {hotels.map((h) => (
              <tr key={h.id}>
                {editing === h.id ? (
                  <td colSpan={5}>
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(() => api(`/hotels/${h.id}`, { method: 'PATCH', body: editForm }), 'Saved.').then((ok) => ok && setEditing(null));
                      }}
                    >
                      <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required maxLength={200} aria-label="Hotel name" />
                      <input value={editForm.city} onChange={(e) => setEditForm({ ...editForm, city: e.target.value })} placeholder="City" maxLength={100} aria-label="City" />
                      <button type="submit">Save</button>
                      <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  </td>
                ) : merging === h.id ? (
                  <td colSpan={5}>
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(
                          () => api(`/hotels/${h.id}/merge`, { method: 'POST', body: { intoHotelId: Number(mergeInto) } }),
                          (res) => `Merged. ${res.bookingsMoved} booking(s) moved to ${res.hotel.name}.`,
                        ).then((ok) => ok && setMerging(null));
                      }}
                    >
                      <span>Merge <strong>{h.name}</strong> into</span>
                      <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} required>
                        <option value="">Choose…</option>
                        {hotels.filter((o) => o.id !== h.id).map((o) => <option key={o.id} value={o.id}>{o.name}{o.city ? `, ${o.city}` : ''}</option>)}
                      </select>
                      <button type="submit">Merge</button>
                      <button type="button" className="secondary" onClick={() => setMerging(null)}>Cancel</button>
                    </form>
                  </td>
                ) : (
                  <>
                    <td>{h.name}</td>
                    <td>{h.city}</td>
                    <td>{h.reviewStatus === 'pending' ? <span className="badge warn">Pending</span> : 'Complete'}</td>
                    <td>{h.bookingCount}</td>
                    <td className="actions">
                      <button type="button" className="link" onClick={() => { setEditing(h.id); setEditForm({ name: h.name, city: h.city || '' }); }}>Edit</button>
                      {h.reviewStatus === 'pending' && (
                        <button type="button" className="link" onClick={() => run(() => api(`/hotels/${h.id}`, { method: 'PATCH', body: { reviewStatus: 'active' } }), `${h.name} marked complete.`)}>
                          Mark complete
                        </button>
                      )}
                      <button type="button" className="link" onClick={() => { setMerging(h.id); setMergeInto(''); }}>Merge into…</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
