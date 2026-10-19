import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Admin: divisions. A division with users or bookings can be archived but never deleted.

export default function AdminDivisions() {
  const [divisions, setDivisions] = useState([]);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      setDivisions((await api('/admin/divisions')).divisions);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function run(fn, done) {
    setError('');
    setNotice('');
    try {
      await fn();
      await load();
      setNotice(done);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  return (
    <section className="card">
      <h1>Divisions</h1>
      <p className="muted">
        Every user belongs to one division. Only sales coordinators are limited to their division&rsquo;s bookings.
        Archived divisions are not offered for new users or bookings.
      </p>

      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api('/admin/divisions', { method: 'POST', body: { name } }), `${name} added.`).then((ok) => ok && setName(''));
        }}
      >
        <label>
          New division
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </label>
        <button type="submit">Add</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Users</th><th>Bookings</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {divisions.map((d) => (
              <tr key={d.id} className={d.archived ? 'inactive' : ''}>
                <td>
                  {editing === d.id ? (
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(() => api(`/admin/divisions/${d.id}`, { method: 'PATCH', body: { name: editName } }), 'Renamed.')
                          .then((ok) => ok && setEditing(null));
                      }}
                    >
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} required maxLength={100} autoFocus />
                      <button type="submit">Save</button>
                      <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : d.name}
                </td>
                <td>{d.userCount}</td>
                <td>{d.bookingCount}</td>
                <td>{d.archived ? 'Archived' : 'Active'}</td>
                <td className="actions">
                  <button type="button" className="link" onClick={() => { setEditing(d.id); setEditName(d.name); }}>Edit</button>
                  {d.archived ? (
                    <button type="button" className="link" onClick={() => run(() => api(`/admin/divisions/${d.id}/restore`, { method: 'POST' }), `${d.name} restored.`)}>
                      Restore
                    </button>
                  ) : (
                    <button type="button" className="link" onClick={() => run(() => api(`/admin/divisions/${d.id}/archive`, { method: 'POST' }), `${d.name} archived.`)}>
                      Archive
                    </button>
                  )}
                  {d.userCount === 0 && d.bookingCount === 0 && (
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => window.confirm(`Delete ${d.name}?`)
                        && run(() => api(`/admin/divisions/${d.id}`, { method: 'DELETE' }), `${d.name} deleted.`)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
