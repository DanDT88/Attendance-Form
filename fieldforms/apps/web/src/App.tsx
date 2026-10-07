import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { SyncChip } from './components/SyncChip';
import { useAuth } from './lib/auth';
import { AdminPage } from './pages/Admin';
import { ConsentPage } from './pages/Consent';
import { LoginPage } from './pages/Login';
import { OutboxPage } from './pages/Outbox';
import { RegisterPage } from './pages/Register';
import { RegisterDetailPage } from './pages/RegisterDetail';
import { ReportsPage } from './pages/Reports';

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
      {offline && <div className="banner">You are offline. Registers are saved on this phone and sent when you reconnect.</div>}
      <main>
        <Routes>
          <Route path="/" element={<Navigate to={office ? '/reports' : '/register'} replace />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/outbox" element={<OutboxPage />} />
          {office && <Route path="/reports" element={<ReportsPage />} />}
          {office && <Route path="/registers/:id" element={<RegisterDetailPage />} />}
          {me.role === 'admin' && <Route path="/admin/*" element={<AdminPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
