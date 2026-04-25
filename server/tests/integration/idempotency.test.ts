import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const SERVER_URL = 'http://localhost:3000';
const CLIENT_SECRET = process.env['HUBSPOT_CLIENT_SECRET']!;
const PORTAL_ID = parseInt(process.env['HUBSPOT_PORTAL_ID']!, 10);
const LOGIN_EMAIL = 'admin@lahzo.dev';
const LOGIN_PASSWORD = 'admin123';

/**
 * Integration test: Idempotent re-delivery of the same webhook event.
 *
 * Requires a running server + PostgreSQL + Redis (npm run dev).
 * Sends the exact same webhook payload twice and verifies:
 * 1. First delivery is accepted (accepted: 1)
 * 2. Second delivery is skipped as duplicate (duplicates: 1)
 * 3. Only one sync_event exists in the database for this event ID
 */

let authToken: string;

async function login(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  const data = (await res.json()) as { token: string };
  return data.token;
}

function signPayload(payload: string): string {
  return crypto
    .createHash('sha256')
    .update(CLIENT_SECRET + payload)
    .digest('hex');
}

async function sendWebhook(payload: string, signature: string) {
  return fetch(`${SERVER_URL}/webhooks/hubspot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hubspot-signature': signature,
    },
    body: payload,
  });
}

describe('Idempotency — duplicate webhook re-delivery', () => {
  const uniqueEventId = Date.now() + Math.floor(Math.random() * 100000);
  const contactId = 88800 + Math.floor(Math.random() * 1000);

  const payload = JSON.stringify([
    {
      objectId: contactId,
      eventId: uniqueEventId,
      subscriptionType: 'contact.creation',
      occurredAt: Date.now(),
      portalId: PORTAL_ID,
      subscriptionId: 1,
      appId: 1,
      changeSource: 'CRM',
      attemptNumber: 0,
    },
  ]);
  const signature = signPayload(payload);

  beforeAll(async () => {
    authToken = await login();
  });

  afterAll(async () => {
    // Clean up test contact
    const res = await fetch(`${SERVER_URL}/api/contacts?limit=100`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const body = (await res.json()) as { data: Array<{ id: string; hubspot_contact_id: string }> };
    const testContact = body.data.find((c) => c.hubspot_contact_id === String(contactId));
    // Contact will be cleaned up by future seed runs or manually
    if (testContact) {
      console.log(`Test contact ${testContact.id} (hubspot ID ${contactId}) created — clean up manually if needed`);
    }
  });

  it('first delivery is accepted', async () => {
    const res = await sendWebhook(payload, signature);
    const body = (await res.json()) as { accepted: number; duplicates: number };

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);
  });

  it('second delivery (same payload) is skipped as duplicate', async () => {
    const res = await sendWebhook(payload, signature);
    const body = (await res.json()) as { accepted: number; duplicates: number };

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(0);
    expect(body.duplicates).toBe(1);
  });

  it('only one sync_event exists for this event ID', async () => {
    // Wait a moment for processing
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${SERVER_URL}/api/contacts?limit=100`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const body = (await res.json()) as { data: Array<{ id: string; hubspot_contact_id: string }> };
    const testContact = body.data.find((c) => c.hubspot_contact_id === String(contactId));
    expect(testContact).toBeDefined();

    const detailRes = await fetch(`${SERVER_URL}/api/contacts/${testContact!.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const detail = (await detailRes.json()) as { events: Array<{ hubspot_event_id: string; direction: string }> };
    const inboundEvents = detail.events.filter(
      (e) => e.hubspot_event_id === String(uniqueEventId),
    );

    expect(inboundEvents).toHaveLength(1);
  });
});
