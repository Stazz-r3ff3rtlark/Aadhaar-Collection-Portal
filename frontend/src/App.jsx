import { Component, useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import SignIn from './pages/SignIn.jsx';
import Home from './pages/Home.jsx';
import AdminUsers from './pages/AdminUsers.jsx';
import AdminDivisions from './pages/AdminDivisions.jsx';
import Hotels from './pages/Hotels.jsx';
import Bookings from './pages/Bookings.jsx';
import BookingForm from './pages/BookingForm.jsx';
import BookingDetail from './pages/BookingDetail.jsx';
import EmployeePage from './pages/EmployeePage.jsx';
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

/** Shows a message instead of a blank page if something on screen fails. */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="center">
          <div className="card narrow">
            <h1>Something went wrong</h1>
            <p>Please reload the page. If it keeps happening, contact Digilabs.</p>
            <button type="button" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

const BOOKING_ROLES = ['coordinator', 'hospitality', 'admin'];

function Page({ route, user }) {
  const isAdmin = user.role === 'admin';
  const seesBookings = BOOKING_ROLES.includes(user.role);
  const managesHotels = user.role === 'admin' || user.role === 'hospitality';

  if (route === '/admin/users' && isAdmin) return <AdminUsers currentUser={user} />;
  if (route === '/admin/divisions' && isAdmin) return <AdminDivisions />;
  if (route === '/hotels' && managesHotels) return <Hotels />;
  if (seesBookings) {
    if (route === '/bookings') return <Bookings user={user} />;
    if (route === '/bookings/new' && user.role === 'coordinator') return <BookingForm />;
    const edit = route.match(/^\/bookings\/(\d+)\/edit$/);
    if (edit) return <BookingForm bookingId={Number(edit[1])} />;
    const detail = route.match(/^\/bookings\/(\d+)$/);
    if (detail) return <BookingDetail bookingId={Number(detail[1])} user={user} />;
  }
  return <Home user={user} />;
}

export default function App() {
  const route = useHashRoute();
  // The shared booking link: employees never sign in as staff.
  const booking = route.match(/^\/b\/([A-Za-z0-9_-]{20,100})$/);
  if (booking) return <ErrorBoundary><EmployeePage token={booking[1]} /></ErrorBoundary>;
  return <StaffApp route={route} />;
}

function StaffApp({ route }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out

  const loadUser = useCallback(async () => {
    try {
      const { user: me } = await api('/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => { loadUser(); }, [loadUser]);

  // If the session ends (signed out elsewhere, account changed or deactivated), go back to sign-in.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('session-expired', onExpired);
    return () => window.removeEventListener('session-expired', onExpired);
  }, []);

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    window.location.hash = '';
  }

  if (user === undefined) return <main className="center muted">Loading…</main>;
  if (!user) return <ErrorBoundary><SignIn onSignedIn={setUser} /></ErrorBoundary>;

  const isAdmin = user.role === 'admin';
  return (
    <ErrorBoundary>
      <div className="shell">
        <header className="topbar">
          <a href="#/" className="brand">Aadhaar Collection Portal</a>
          <nav>
            {BOOKING_ROLES.includes(user.role) && <a href="#/bookings">Bookings</a>}
            {(isAdmin || user.role === 'hospitality') && <a href="#/hotels">Hotels</a>}
            {isAdmin && <a href="#/admin/users">Users</a>}
            {isAdmin && <a href="#/admin/divisions">Divisions</a>}
          </nav>
          <div className="who">
            <span>{user.name}</span>
            <span className="badge">{ROLE_LABELS[user.role]}</span>
            <button type="button" className="link" onClick={signOut}>Sign out</button>
          </div>
        </header>
        <main className="content">
          <Page route={route} user={user} />
        </main>
      </div>
    </ErrorBoundary>
  );
}
