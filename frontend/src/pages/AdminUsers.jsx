import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate, formatDateTime } from '../dates.js';
import { ROLE_LABELS } from '../roles.js';

// Admin: the sign-in allow-list. Only emails added here can sign in.

export default function AdminUsers({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ email: '', name: '', role: 'coordinator', divisionId: '' });

  async function load() {
    try {
      const [u, d] = await Promise.all([api('/admin/users'), api('/admin/divisions')]);
      setUsers(u.users);
      setDivisions(d.divisions);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  const divisionName = (id) => divisions.find((d) => d.id === id)?.name ?? '';

  async function addUser(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/admin/users', {
        method: 'POST',
        body: { ...form, divisionId: form.role === 'coordinator' ? Number(form.divisionId) : null },
      });
      setForm({ email: '', name: '', role: form.role, divisionId: form.divisionId });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function setActive(user, isActive) {
    if (!isActive && !window.confirm(`Deactivate ${user.email}? They will be signed out immediately.`)) return;
    setError('');
    try {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { isActive } });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h1>Users</h1>
      <p className="muted">Only @alembic.co.in emails on this list can sign in. Deactivated users are signed out at once.</p>

      <form className="row-form" onSubmit={addUser}>
        <label>
          Email
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@alembic.co.in" required />
        </label>
        <label>
          Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label>
          Role
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {form.role === 'coordinator' && (
          <label>
            Division
            <select value={form.divisionId} onChange={(e) => setForm({ ...form, divisionId: e.target.value })} required>
              <option value="">Choose…</option>
              {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        <button type="submit">Add user</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Division</th>
              <th>Last sign-in</th>
              <th>Added</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.isActive ? '' : 'inactive'}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>{divisionName(u.divisionId)}</td>
                <td>{formatDateTime(u.lastLoginAt)}</td>
                <td>{formatDate(u.createdAt)}</td>
                <td>
                  {u.id === currentUser.id ? 'You' : (
                    <button type="button" className="link" onClick={() => setActive(u, !u.isActive)}>
                      {u.isActive ? 'Deactivate' : 'Reactivate'}
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
