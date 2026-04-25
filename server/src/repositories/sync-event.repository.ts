import { query } from '../db/client.js';
import type { SyncEvent, SyncStatus, EventDirection } from '../domain/types.js';

export async function insert(params: {
  contact_id: string;
  hubspot_event_id: string | null;
  direction: EventDirection;
  event_type: string;
  payload: unknown;
  status: SyncStatus;
  occurred_at: Date | null;
}): Promise<SyncEvent> {
  const result = await query<SyncEvent>(
    `INSERT INTO sync_events (contact_id, hubspot_event_id, direction, event_type, payload, status, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.contact_id,
      params.hubspot_event_id,
      params.direction,
      params.event_type,
      JSON.stringify(params.payload),
      params.status,
      params.occurred_at,
    ],
  );
  return result.rows[0]!;
}

export async function findById(id: string): Promise<SyncEvent | null> {
  const result = await query<SyncEvent>('SELECT * FROM sync_events WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function findByContactId(contactId: string): Promise<SyncEvent[]> {
  const result = await query<SyncEvent>(
    'SELECT * FROM sync_events WHERE contact_id = $1 ORDER BY created_at DESC',
    [contactId],
  );
  return result.rows;
}

export async function existsByHubspotEventId(hubspotEventId: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM sync_events WHERE hubspot_event_id = $1) AS exists',
    [hubspotEventId],
  );
  return result.rows[0]!.exists;
}

export async function updateStatus(
  id: string,
  status: SyncStatus,
  errorMessage?: string,
): Promise<void> {
  const isTerminal = ['synced', 'failed', 'skipped_stale'].includes(status);
  await query(
    `UPDATE sync_events
     SET status = $2,
         error_message = $3,
         processed_at = CASE WHEN $4 THEN NOW() ELSE processed_at END
     WHERE id = $1`,
    [id, status, errorMessage ?? null, isTerminal],
  );
}

export async function findRecentFailures(limit: number): Promise<SyncEvent[]> {
  const result = await query<SyncEvent>(
    `SELECT * FROM sync_events
     WHERE status = 'failed'
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}
