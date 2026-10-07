import { lazy, Suspense } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { SyncChip } from './components/SyncChip';
import { useAuth } from './lib/auth';
import { ConsentPage } from './pages/Consent';
import { LoginPage } from './pages/Login';
import { OutboxPage } from './pages/Outbox';
import { RegisterPage } from './pages/Register';

// Office screens load on demand so supervisors' phones fetch less on first install. The service
// worker still precaches every chunk, so they work offline once the app has been installed.
const AdminPage = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })));
const RegisterDetailPage = lazy(() =>
  import('./pages/RegisterDetail').then((m) => ({ default: m.RegisterDetailPage })),
);
const ReportsPage = lazy(() => import('./pages/Reports').then((m) => ({ default: m.ReportsPage })));

export function App() {
  const { me, loading, offline, signOut } = useAuth();

  if (loading) return <div className="center muted">Loading…</div>;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (me.consentRequired && !offline) return <ConsentPage />;

  const office = me.role === 'manager' || me.role === 'admin';
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          FieldForms
        </Link>
        <nav>
          <NavLink to="/register">Register</NavLink>
          <NavLink to="/outbox">Outbox</NavLink>
          {office && <NavLink to="/reports">Reports</NavLink>}
          {me.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="topbar-right">
          <SyncChip />
          <button className="link" onClick={() => void signOut()} title={me.displayName}>
            Sign out
          </button>
        </div>
      </header>
      {offline && (
        <div className="banner">
          You are offline. Registers are saved on this phone and sent when you reconnect.
        </div>
      )}
      <main>
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Routes>
            <Route path="/" element={<Navigate to={office ? '/reports' : '/register'} replace />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/outbox" element={<OutboxPage />} />
            {office && <Route path="/reports" element={<ReportsPage />} />}
            {office && <Route path="/registers/:id" element={<RegisterDetailPage />} />}
            {me.role === 'admin' && <Route path="/admin/*" element={<AdminPage />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
