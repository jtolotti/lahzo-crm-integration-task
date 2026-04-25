import { useEffect, useState } from 'react';
import { api, type RawWebhook } from '../lib/api.ts';
import { FileText, ChevronDown, ChevronRight, Loader2, CheckCircle, Clock } from 'lucide-react';

export function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<RawWebhook[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const limit = 20;

  useEffect(() => {
    load();
  }, [page]);

  async function load() {
    setLoading(true);
    try {
      const res = await api.getWebhooks(page, limit);
      setWebhooks(res.data);
      setTotal(res.total);
    } catch {
      // handled by api client
    } finally {
      setLoading(false);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FileText size={24} className="text-blue-400" />
        <div>
          <h1 className="text-xl font-bold text-white">Webhooks Log</h1>
          <p className="text-sm text-slate-400">Raw webhook payloads received from HubSpot — admin only</p>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-500">
            <Loader2 size={24} className="animate-spin" />
          </div>
        ) : webhooks.length === 0 ? (
          <div className="text-center py-12 text-slate-500">No webhooks received yet</div>
        ) : (
          <div className="divide-y divide-slate-800">
            {webhooks.map((wh) => (
              <div key={wh.id}>
                <button
                  onClick={() => toggleExpand(wh.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/30 transition-colors"
                >
                  {expanded.has(wh.id) ? (
                    <ChevronDown size={16} className="text-slate-500 shrink-0" />
                  ) : (
                    <ChevronRight size={16} className="text-slate-500 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-slate-300 truncate">{wh.id}</span>
                      {wh.processed ? (
                        <CheckCircle size={14} className="text-green-400 shrink-0" />
                      ) : (
                        <Clock size={14} className="text-yellow-400 shrink-0" />
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {new Date(wh.received_at).toLocaleString()}
                      {' · '}
                      {Array.isArray(wh.payload) ? `${wh.payload.length} event(s)` : '1 event'}
                    </div>
                  </div>
                </button>

                {expanded.has(wh.id) && (
                  <div className="px-4 pb-4 space-y-3">
                    <div>
                      <div className="text-xs font-semibold text-slate-500 mb-1">Payload</div>
                      <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto max-h-64 overflow-y-auto">
                        {JSON.stringify(wh.payload, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-500 mb-1">Headers</div>
                      <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto max-h-48 overflow-y-auto">
                        {JSON.stringify(wh.headers, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

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
