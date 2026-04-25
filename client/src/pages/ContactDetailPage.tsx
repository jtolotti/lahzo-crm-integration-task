import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, type Contact, type SyncEvent } from '../lib/api.ts';
import { ArrowLeft, RotateCw, RefreshCw, CheckCircle, XCircle, ArrowUpRight, ArrowDownLeft, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { useAuth } from '../context/auth.tsx';

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin } = useAuth();
  const [contact, setContact] = useState<Contact | null>(null);
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [expandedPayload, setExpandedPayload] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  useEffect(() => {
    if (id) load(id);
  }, [id]);

  async function load(contactId: string) {
    setLoading(true);
    try {
      const res = await api.getContact(contactId);
      setContact(res.contact);
      setEvents(res.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function handleResync() {
    if (!id) return;
    setResyncing(true);
    setError('');
    try {
      await api.resyncContact(id);
      await load(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-sync failed');
    } finally {
      setResyncing(false);
    }
  }

  function togglePayload(eventId: string) {
    setExpandedPayload((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  async function handleRetry(eventId: string) {
    setRetrying(eventId);
    try {
      await api.retryEvent(eventId);
      if (id) await load(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  if (!contact) {
    return <div className="text-center py-24 text-slate-500">{error || 'Contact not found'}</div>;
  }

  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white transition-colors">
        <ArrowLeft size={16} /> Back to contacts
      </Link>

      {/* Contact info card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">
              {contact.first_name ?? ''} {contact.last_name ?? ''}
              {!contact.first_name && !contact.last_name && 'Unknown Contact'}
            </h1>
            <p className="text-slate-400 mt-1">{contact.email ?? 'No email'}</p>
          </div>
          <div className="flex items-start gap-4">
            <button
              onClick={handleResync}
              disabled={resyncing}
              className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              <RefreshCw size={14} className={resyncing ? 'animate-spin' : ''} />
              {resyncing ? 'Re-syncing...' : 'Re-sync'}
            </button>
            <div className="text-right">
              {contact.lahzo_score !== null && (
                <div className="text-3xl font-bold text-white">{contact.lahzo_score}</div>
              )}
              {contact.lahzo_status && (
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                  contact.lahzo_status === 'hot' ? 'bg-red-500/20 text-red-400' :
                  contact.lahzo_status === 'warm' ? 'bg-yellow-500/20 text-yellow-400' :
                  'bg-blue-500/20 text-blue-400'
                }`}>{contact.lahzo_status}</span>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          <InfoItem label="HubSpot ID" value={contact.hubspot_contact_id} />
          <InfoItem label="Sync Status" value={contact.sync_status} />
          <InfoItem label="Last Event" value={contact.last_event_occurred_at ? new Date(contact.last_event_occurred_at).toLocaleString() : '—'} />
          <InfoItem label="Updated" value={new Date(contact.updated_at).toLocaleString()} />
        </div>

        {contact.last_error && (
          <div className="mt-4 p-3 bg-red-950/50 border border-red-900 rounded-lg text-sm text-red-400">
            <strong>Last Error:</strong> {contact.last_error}
          </div>
        )}
      </div>

      {/* Sync events */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-white">Sync Events ({events.length})</h2>
        </div>

        {error && (
          <div className="px-4 py-2 text-sm text-red-400">{error}</div>
        )}

        {events.length === 0 ? (
          <div className="text-center py-8 text-slate-500">No sync events</div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {events.map((ev) => (
              <div key={ev.id}>
                <div className="px-4 py-3 flex items-center gap-4 hover:bg-slate-800/30 transition-colors">
                  {isAdmin ? (
                    <button onClick={() => togglePayload(ev.id)} className="flex-shrink-0">
                      {expandedPayload.has(ev.id) ? (
                        <ChevronDown size={18} className={ev.direction === 'inbound' ? 'text-blue-400' : 'text-purple-400'} />
                      ) : (
                        <ChevronRight size={18} className={ev.direction === 'inbound' ? 'text-blue-400' : 'text-purple-400'} />
                      )}
                    </button>
                  ) : (
                    <div className="flex-shrink-0">
                      {ev.direction === 'inbound' ? (
                        <ArrowDownLeft size={18} className="text-blue-400" />
                      ) : (
                        <ArrowUpRight size={18} className="text-purple-400" />
                      )}
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{ev.event_type}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        ev.direction === 'inbound'
                          ? 'bg-blue-500/10 text-blue-400'
                          : 'bg-purple-500/10 text-purple-400'
                      }`}>{ev.direction}</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {new Date(ev.occurred_at).toLocaleString()}
                      {ev.error_message && <span className="text-red-400 ml-2">— {ev.error_message}</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {ev.status === 'synced' ? (
                      <CheckCircle size={16} className="text-green-400" />
                    ) : ev.status === 'failed' ? (
                      <XCircle size={16} className="text-red-400" />
                    ) : (
                      <span className="text-xs text-slate-500">{ev.status}</span>
                    )}

                    {ev.status === 'failed' && (
                      <button
                        onClick={() => handleRetry(ev.id)}
                        disabled={retrying === ev.id}
                        className="flex items-center gap-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded transition-colors disabled:opacity-50"
                      >
                        <RotateCw size={12} className={retrying === ev.id ? 'animate-spin' : ''} />
                        Retry
                      </button>
                    )}
                  </div>
                </div>

                {isAdmin && expandedPayload.has(ev.id) && (
                  <div className="px-4 pb-3 pl-12">
                    <div className="text-xs font-semibold text-slate-500 mb-1">Payload</div>
                    <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto max-h-48 overflow-y-auto">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm text-slate-200 mt-0.5 font-mono">{value}</div>
    </div>
  );
}
