import { query } from '../db/client.js';
import type { Contact, SyncStatus } from '../domain/types.js';

export async function upsertFromEvent(
  hubspotContactId: string,
  occurredAt: Date,
): Promise<Contact> {
  const result = await query<Contact>(
    `INSERT INTO contacts (hubspot_contact_id, last_event_occurred_at, sync_status)
     VALUES ($1, $2, 'received')
     ON CONFLICT (hubspot_contact_id) DO UPDATE
       SET updated_at = NOW()
     RETURNING *`,
    [hubspotContactId, occurredAt],
  );
  return result.rows[0]!;
}

export async function findById(id: string): Promise<Contact | null> {
  const result = await query<Contact>('SELECT * FROM contacts WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function findByHubspotId(hubspotContactId: string): Promise<Contact | null> {
  const result = await query<Contact>(
    'SELECT * FROM contacts WHERE hubspot_contact_id = $1',
    [hubspotContactId],
  );
  return result.rows[0] ?? null;
}

export async function findAll(
  page: number,
  limit: number,
  statusFilter?: SyncStatus,
): Promise<{ data: Contact[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (statusFilter) {
    params.push(statusFilter);
    conditions.push(`sync_status = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query<{ count: string }>(`SELECT COUNT(*) FROM contacts ${where}`, params);
  const total = parseInt(countResult.rows[0]!.count, 10);

  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const result = await query<Contact>(
    `SELECT * FROM contacts ${where} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { data: result.rows, total };
}

export async function updateContactFields(
  id: string,
  fields: {
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  },
): Promise<void> {
  await query(
    `UPDATE contacts
     SET email = COALESCE($2, email),
         first_name = COALESCE($3, first_name),
         last_name = COALESCE($4, last_name),
         updated_at = NOW()
     WHERE id = $1`,
    [id, fields.email, fields.first_name, fields.last_name],
  );
}

export async function updateSyncStatus(
  id: string,
  newStatus: SyncStatus,
  allowedFromStatuses: SyncStatus[],
  error?: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE contacts
     SET sync_status = $2, last_error = $4, updated_at = NOW()
     WHERE id = $1
     AND sync_status = ANY($3::sync_status[])`,
    [id, newStatus, allowedFromStatuses, error ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateTimestampAndStatus(
  hubspotContactId: string,
  occurredAt: Date,
  newStatus: SyncStatus,
): Promise<boolean> {
  const result = await query(
    `UPDATE contacts
     SET last_event_occurred_at = $2, sync_status = $3, updated_at = NOW()
     WHERE hubspot_contact_id = $1
     AND last_event_occurred_at < $2`,
    [hubspotContactId, occurredAt, newStatus],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateScore(
  id: string,
  score: number,
  status: string,
): Promise<void> {
  await query(
    `UPDATE contacts
     SET lahzo_score = $2, lahzo_status = $3, updated_at = NOW()
     WHERE id = $1`,
    [id, score, status],
  );
}

export async function getStatusCounts(): Promise<Record<string, number>> {
  const result = await query<{ sync_status: string; count: string }>(
    'SELECT sync_status, COUNT(*) FROM contacts GROUP BY sync_status',
  );
  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.sync_status] = parseInt(row.count, 10);
  }
  return counts;
}
