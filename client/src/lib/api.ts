const BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('lahzo_token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as Record<string, string>).error ?? `Request failed: ${res.status}`;

    if (res.status === 401 && token) {
      localStorage.removeItem('lahzo_token');
      localStorage.removeItem('lahzo_user');
      window.location.href = '/login';
    }

    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

export interface Contact {
  id: string;
  hubspot_contact_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  lahzo_score: number | null;
  lahzo_status: string | null;
  sync_status: string;
  last_error: string | null;
  last_event_occurred_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncEvent {
  id: string;
  contact_id: string;
  hubspot_event_id: string | null;
  direction: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  error_message: string | null;
  occurred_at: string;
  processed_at: string | null;
  created_at: string;
}

export interface RawWebhook {
  id: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  received_at: string;
  processed: boolean;
}

export interface LoginResponse {
  token: string;
  user: { userId: string; email: string; name: string; role: 'admin' | 'operator' };
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  getContacts: (page = 1, limit = 20, status?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) params.set('status', status);
    return request<{ data: Contact[]; total: number; page: number; limit: number }>(
      `/contacts?${params}`,
    );
  },

  getContact: (id: string) =>
    request<{ contact: Contact; events: SyncEvent[] }>(`/contacts/${id}`),

  getStats: () =>
    request<Record<string, number>>('/contacts/stats/summary'),

  getFailures: (limit = 50) =>
    request<{ data: SyncEvent[] }>(`/sync-events/failures?limit=${limit}`),

  retryEvent: (id: string) =>
    request<{ status: string; jobId: string }>(`/sync-events/${id}/retry`, { method: 'POST' }),

  resyncContact: (id: string) =>
    request<{ status: string; jobId: string; syncEventId: string }>(`/contacts/${id}/resync`, { method: 'POST' }),

  // Admin-only endpoints
  getWebhooks: (page = 1, limit = 20) =>
    request<{ data: RawWebhook[]; total: number; page: number; limit: number }>(
      `/admin/webhooks?page=${page}&limit=${limit}`,
    ),

  getWebhook: (id: string) =>
    request<RawWebhook>(`/admin/webhooks/${id}`),

  getSyncEventPayload: (id: string) =>
    request<{ id: string; event_type: string; direction: string; payload: Record<string, unknown>; error_message: string | null }>(
      `/admin/sync-events/${id}/payload`,
    ),
};
