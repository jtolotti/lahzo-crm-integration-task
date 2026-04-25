import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Contact } from '../lib/api.ts';
import { Users, CheckCircle, XCircle, Clock, SkipForward, Loader2, RefreshCw } from 'lucide-react';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof Users }> = {
  received:      { label: 'Received',      color: 'bg-blue-500/10 text-blue-400 border-blue-500/20',     icon: Clock },
  processing:    { label: 'Processing',    color: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20', icon: Loader2 },
  synced:        { label: 'Synced',        color: 'bg-green-500/10 text-green-400 border-green-500/20',   icon: CheckCircle },
  failed:        { label: 'Failed',        color: 'bg-red-500/10 text-red-400 border-red-500/20',         icon: XCircle },
  skipped_stale: { label: 'Skipped',       color: 'bg-slate-500/10 text-slate-400 border-slate-500/20',   icon: SkipForward },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, color: 'bg-slate-500/10 text-slate-400 border-slate-500/20', icon: Clock };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.color}`}>
      <cfg.icon size={12} />
      {cfg.label}
    </span>
  );
}

export function DashboardPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const limit = 20;

  useEffect(() => {
    load();
  }, [page, statusFilter]);

  async function load() {
    setLoading(true);
    try {
      const [contactsRes, statsRes] = await Promise.all([
        api.getContacts(page, limit, statusFilter || undefined),
        api.getStats(),
      ]);
      setContacts(contactsRes.data);
      setTotal(contactsRes.total);
      setStats(statsRes);
    } catch {
      // auth redirect handled by api client
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const [contactsRes, statsRes] = await Promise.all([
        api.getContacts(page, limit, statusFilter || undefined),
        api.getStats(),
      ]);
      setContacts(contactsRes.data);
      setTotal(contactsRes.total);
      setStats(statsRes);
    } catch {
      // auth redirect handled by api client
    } finally {
      setRefreshing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const totalContacts = Object.values(stats).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <button
          onClick={() => { setStatusFilter(''); setPage(1); }}
          className={`rounded-xl border p-4 text-left transition-colors ${!statusFilter ? 'bg-slate-800 border-blue-500' : 'bg-slate-900 border-slate-800 hover:border-slate-600'}`}
        >
          <div className="text-2xl font-bold text-white">{totalContacts}</div>
          <div className="text-xs text-slate-400 mt-1">All Contacts</div>
        </button>
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <button
            key={key}
            onClick={() => { setStatusFilter(key); setPage(1); }}
            className={`rounded-xl border p-4 text-left transition-colors ${statusFilter === key ? 'bg-slate-800 border-blue-500' : 'bg-slate-900 border-slate-800 hover:border-slate-600'}`}
          >
            <div className="text-2xl font-bold text-white">{stats[key] ?? 0}</div>
            <div className={`text-xs mt-1 ${cfg.color.split(' ')[1]}`}>{cfg.label}</div>
          </button>
        ))}
      </div>

      {/* Contacts table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-white">
            Contacts {statusFilter && `(${STATUS_CONFIG[statusFilter]?.label})`}
          </h2>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh data"
            className="text-slate-400 hover:text-white disabled:opacity-50 transition-colors p-1"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-500">
            <Loader2 size={24} className="animate-spin" />
          </div>
        ) : contacts.length === 0 ? (
          <div className="text-center py-12 text-slate-500">No contacts found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-800">
                  <th className="px-4 py-2 font-medium">Contact</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Score</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Sync</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link to={`/contacts/${c.id}`} className="text-blue-400 hover:text-blue-300 font-medium">
                        {c.first_name ?? ''} {c.last_name ?? ''}
                        {!c.first_name && !c.last_name && <span className="text-slate-500">Unknown</span>}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{c.email ?? <span className="text-slate-600">—</span>}</td>
                    <td className="px-4 py-3">
                      {c.lahzo_score !== null ? (
                        <span className="font-mono font-bold text-white">{c.lahzo_score}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.lahzo_status ? (
                        <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                          c.lahzo_status === 'hot' ? 'bg-red-500/20 text-red-400' :
                          c.lahzo_status === 'warm' ? 'bg-yellow-500/20 text-yellow-400' :
                          'bg-blue-500/20 text-blue-400'
                        }`}>{c.lahzo_status}</span>
                      ) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={c.sync_status} /></td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {new Date(c.updated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 text-sm">
            <span className="text-slate-500">{total} total</span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 rounded bg-slate-800 text-slate-300 disabled:text-slate-600 disabled:cursor-not-allowed hover:bg-slate-700"
              >
                Prev
              </button>
              <span className="px-3 py-1 text-slate-400">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 rounded bg-slate-800 text-slate-300 disabled:text-slate-600 disabled:cursor-not-allowed hover:bg-slate-700"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
