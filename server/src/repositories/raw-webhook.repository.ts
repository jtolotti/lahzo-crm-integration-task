import { query } from '../db/client.js';
import type { RawWebhook } from '../domain/types.js';

export async function insertRawWebhook(
  payload: unknown,
  headers: Record<string, unknown>,
): Promise<RawWebhook> {
  const result = await query<RawWebhook>(
    `INSERT INTO raw_webhooks (payload, headers)
     VALUES ($1, $2)
     RETURNING *`,
    [JSON.stringify(payload), JSON.stringify(headers)],
  );
  return result.rows[0]!;
}

export async function markProcessed(id: string): Promise<void> {
  await query('UPDATE raw_webhooks SET processed = TRUE WHERE id = $1', [id]);
}

export async function findUnprocessed(): Promise<RawWebhook[]> {
  const result = await query<RawWebhook>(
    'SELECT * FROM raw_webhooks WHERE processed = FALSE ORDER BY received_at ASC',
  );
  return result.rows;
}

export async function findById(id: string): Promise<RawWebhook | null> {
  const result = await query<RawWebhook>('SELECT * FROM raw_webhooks WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function findAll(page: number, limit: number): Promise<{ data: RawWebhook[]; total: number }> {
  const offset = (page - 1) * limit;
  const [dataResult, countResult] = await Promise.all([
    query<RawWebhook>(
      'SELECT * FROM raw_webhooks ORDER BY received_at DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    ),
    query<{ count: string }>('SELECT COUNT(*)::text AS count FROM raw_webhooks'),
  ]);
  return {
    data: dataResult.rows,
    total: parseInt(countResult.rows[0]!.count, 10),
  };
}
