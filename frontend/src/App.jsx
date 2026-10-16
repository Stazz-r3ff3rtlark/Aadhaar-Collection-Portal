import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import SignIn from './pages/SignIn.jsx';
import Home from './pages/Home.jsx';
import AdminUsers from './pages/AdminUsers.jsx';
import { ROLE_LABELS } from './roles.js';

function useHashRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const route = useHashRoute();

  const loadUser = useCallback(async () => {
    try {
      const { user: me } = await api('/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => { loadUser(); }, [loadUser]);

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    window.location.hash = '';
  }

  if (user === undefined) return <main className="center muted">Loading…</main>;
  if (!user) return <SignIn onSignedIn={setUser} />;

  const isAdmin = user.role === 'admin';
  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/" className="brand">Aadhaar Collection Portal</a>
        <nav>
          {isAdmin && <a href="#/admin/users">Users</a>}
        </nav>
        <div className="who">
          <span>{user.name}</span>
          <span className="badge">{ROLE_LABELS[user.role]}</span>
          <button type="button" className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="content">
        {route === '/admin/users' && isAdmin ? <AdminUsers currentUser={user} /> : <Home user={user} />}
      </main>
    </div>
  );
}
