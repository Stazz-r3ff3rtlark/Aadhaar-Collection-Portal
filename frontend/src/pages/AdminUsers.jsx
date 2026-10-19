import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate, formatDateTime } from '../dates.js';
import { ROLE_LABELS } from '../roles.js';

// Admin: the sign-in allow-list. Only emails added here can sign in. Every user has one
// division; only sales coordinators are limited by it.

const EMPTY = { email: '', name: '', role: 'coordinator', divisionId: '' };

function UserForm({ initial, divisions, submitLabel, onSubmit, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  // Archived divisions are not offered, except the user's current one.
  const options = divisions.filter((d) => !d.archived || d.id === Number(initial.divisionId));

  return (
    <form
      className="row-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...form, divisionId: Number(form.divisionId) });
      }}
    >
      <label>
        Email
        <input type="email" value={form.email} onChange={set('email')} placeholder="name@alembic.co.in" required />
      </label>
      <label>
        Name
        <input value={form.name} onChange={set('name')} required />
      </label>
      <label>
        Role
        <select value={form.role} onChange={set('role')}>
          {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        Division
        <select value={form.divisionId} onChange={set('divisionId')} required>
          <option value="">Choose…</option>
          {options.map((d) => <option key={d.id} value={d.id}>{d.name}{d.archived ? ' (archived)' : ''}</option>)}
        </select>
      </label>
      <button type="submit">{submitLabel}</button>
      {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
    </form>
  );
}

export default function AdminUsers({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);
  const [formKey, setFormKey] = useState(0);

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

  const addUser = (form) => run(() => api('/admin/users', { method: 'POST', body: form }), `${form.email} added.`)
    .then((ok) => ok && setFormKey((k) => k + 1));

  const saveEdit = (user, form) => {
    const body = {};
    for (const key of ['email', 'name', 'role', 'divisionId']) if (form[key] !== user[key]) body[key] = form[key];
    if (user.id === currentUser.id && Object.keys(body).length
      && !window.confirm('Saving changes to your own account signs you out. Continue?')) return;
    run(() => api(`/admin/users/${user.id}`, { method: 'PATCH', body }), 'Saved. The user has been signed out so the changes apply.')
      .then((ok) => ok && setEditing(null));
  };

  function setActive(user, isActive) {
    if (!isActive && !window.confirm(`Deactivate ${user.email}? They will be signed out immediately.`)) return;
    run(() => api(`/admin/users/${user.id}`, { method: 'PATCH', body: { isActive } }), isActive ? 'Reactivated.' : 'Deactivated.');
  }

  function remove(user) {
    if (!window.confirm(`Delete ${user.email}? This is only possible for an account that has never been used.`)) return;
    run(() => api(`/admin/users/${user.id}`, { method: 'DELETE' }), `${user.email} deleted.`);
  }

  return (
    <section className="card">
      <h1>Users</h1>
      <p className="muted">
        Only @alembic.co.in emails on this list can sign in. Any change signs the user out at once.
        Accounts that have been used can only be deactivated, so the history log keeps their name.
      </p>

      <h2>Add a user</h2>
      <UserForm key={formKey} initial={EMPTY} divisions={divisions} submitLabel="Add user" onSubmit={addUser} />

      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

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
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (editing === u.id ? (
              <tr key={u.id}>
                <td colSpan={7}>
                  <UserForm
                    initial={{ email: u.email, name: u.name, role: u.role, divisionId: u.divisionId }}
                    divisions={divisions}
                    submitLabel="Save"
                    onSubmit={(form) => saveEdit(u, form)}
                    onCancel={() => setEditing(null)}
                  />
                </td>
              </tr>
            ) : (
              <tr key={u.id} className={u.isActive ? '' : 'inactive'}>
                <td>{u.name}{u.isActive ? '' : ' (deactivated)'}</td>
                <td>{u.email}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>{u.divisionName}</td>
                <td>{formatDateTime(u.lastLoginAt)}</td>
                <td>{formatDate(u.createdAt)}</td>
                <td className="actions">
                  <button type="button" className="link" onClick={() => { setError(''); setEditing(u.id); }}>Edit</button>
                  {u.id !== currentUser.id && (
                    <>
                      <button type="button" className="link" onClick={() => setActive(u, !u.isActive)}>
                        {u.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                      <button type="button" className="link danger" onClick={() => remove(u)}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
