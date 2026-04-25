import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/auth.tsx';
import { LogOut, Activity, FileText, LayoutDashboard, Shield } from 'lucide-react';

export function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/" className="flex items-center gap-2">
              <Activity size={20} className="text-blue-400" />
              <span className="font-bold text-lg tracking-tight">Lahzo</span>
            </Link>
            <nav className="flex items-center gap-1">
              <Link
                to="/"
                className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors ${
                  location.pathname === '/' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <LayoutDashboard size={14} />
                Dashboard
              </Link>
              {isAdmin && (
                <Link
                  to="/admin/webhooks"
                  className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors ${
                    location.pathname.startsWith('/admin') ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <FileText size={14} />
                  Webhooks Log
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-400">{user?.name}</span>
              {isAdmin && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  <Shield size={10} />
                  ADMIN
                </span>
              )}
            </div>
            <button
              onClick={logout}
              className="flex items-center gap-1 text-sm text-slate-400 hover:text-white transition-colors"
            >
              <LogOut size={16} />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
