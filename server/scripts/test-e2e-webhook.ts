import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const ACCESS_TOKEN = process.env['HUBSPOT_ACCESS_TOKEN']!;
const CLIENT_SECRET = process.env['HUBSPOT_CLIENT_SECRET']!;
const PORTAL_ID = parseInt(process.env['HUBSPOT_PORTAL_ID']!, 10);
const WEBHOOK_URL = 'http://localhost:3000/webhooks/hubspot';
const HUBSPOT_API = 'https://api.hubapi.com';

async function main() {
  // Step 1: Fetch an existing contact from HubSpot to use as test subject
  console.log('1. Fetching existing contact from HubSpot...');
  const listRes = await fetch(
    `${HUBSPOT_API}/crm/v3/objects/contacts?limit=1&properties=email,firstname,lastname`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
  );

  if (!listRes.ok) {
    const err = await listRes.text();
    console.error('Failed to list contacts:', listRes.status, err);
    process.exit(1);
  }

  const listData = (await listRes.json()) as { results: Array<{ id: string; properties: Record<string, string> }> };
  if (listData.results.length === 0) {
    console.error('No contacts found in HubSpot');
    process.exit(1);
  }

  const created = listData.results[0]!;
  console.log(`   Using contact ID: ${created.id}, email: ${created.properties['email']}`);

  // Step 2: Send a signed webhook simulating contact.creation
  console.log('\n2. Sending signed webhook...');
  const eventId = Date.now();
  const payload = JSON.stringify([
    {
      objectId: parseInt(created.id, 10),
      eventId,
      subscriptionType: 'contact.creation',
      occurredAt: Date.now(),
      portalId: PORTAL_ID,
      subscriptionId: 1,
      appId: 1,
      changeSource: 'CRM',
      attemptNumber: 0,
    },
  ]);

  const signature = crypto
    .createHash('sha256')
    .update(CLIENT_SECRET + payload)
    .digest('hex');

  const webhookRes = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hubspot-signature': signature,
    },
    body: payload,
  });

  const webhookBody = await webhookRes.json() as Record<string, unknown>;
  console.log(`   Webhook response: ${webhookRes.status}`, webhookBody);

  if (webhookRes.status !== 200) {
    console.error('\n❌ Webhook was rejected');
    process.exit(1);
  }

  // Step 3: Wait for worker to process (enrichment has 3-15s delay)
  console.log('\n3. Waiting for worker to process (enrichment takes 3-15s)...');
  await new Promise((r) => setTimeout(r, 20000));

  // Step 4: Check the contact in our database
  console.log('\n4. Checking local database...');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: 'postgresql://lahzo:lahzo@localhost:5432/lahzo' });

  const contactResult = await pool.query(
    'SELECT hubspot_contact_id, email, first_name, last_name, lahzo_score, lahzo_status, sync_status FROM contacts WHERE hubspot_contact_id = $1',
    [created.id],
  );

  if (contactResult.rows.length === 0) {
    console.error('   Contact not found in database');
    await pool.end();
    process.exit(1);
  }

  const contact = contactResult.rows[0];
  console.log('   Contact:', contact);

  const eventsResult = await pool.query(
    'SELECT direction, event_type, status, error_message FROM sync_events WHERE contact_id = (SELECT id FROM contacts WHERE hubspot_contact_id = $1) ORDER BY created_at',
    [created.id],
  );
  console.log('   Sync events:', eventsResult.rows);
  await pool.end();

  // Step 5: Verify contact in HubSpot has score written back
  console.log('\n5. Checking HubSpot for writeback...');
  const checkRes = await fetch(
    `${HUBSPOT_API}/crm/v3/objects/contacts/${created.id}?properties=lahzo_score,lahzo_status`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
  );
  const checkData = (await checkRes.json()) as { properties: Record<string, string | null> };
  console.log('   HubSpot properties:', {
    lahzo_score: checkData.properties['lahzo_score'],
    lahzo_status: checkData.properties['lahzo_status'],
  });

  // Verdict
  if (contact['sync_status'] === 'synced' && contact['lahzo_score'] !== null) {
    console.log('\n✅ E2E test PASSED — full pipeline working');
  } else {
    console.log('\n❌ E2E test FAILED');
    console.log('   sync_status:', contact['sync_status']);
    console.log('   lahzo_score:', contact['lahzo_score']);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('E2E test error:', err);
  process.exit(1);
});
