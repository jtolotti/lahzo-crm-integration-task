import { query } from '../db/client.js';
import type { User } from '../domain/types.js';

export async function findByEmail(email: string): Promise<User | null> {
  const result = await query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findById(id: string): Promise<User | null> {
  const result = await query<User>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}
