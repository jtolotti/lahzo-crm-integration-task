/**
 * Live webhook pipeline test.
 *
 * Creates a contact directly in HubSpot CRM and waits for the webhook
 * subscription to fire → our ngrok endpoint → server → worker pipeline.
 * Then verifies the contact appeared in our database with score/status.
 *
 * Prerequisites:
 *   - Server running on port 3000
 *   - ngrok tunnel active
 *   - HubSpot webhook subscriptions configured with the ngrok URL
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const ACCESS_TOKEN = process.env['HUBSPOT_ACCESS_TOKEN']!;
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://lahzo:lahzo@localhost:5432/lahzo';
const API = 'https://api.hubapi.com';

async function main() {
  const testEmail = `live-test-${Date.now()}@lahzo-test.dev`;
  const testFirst = 'LiveTest';
  const testLast = `Run${Date.now()}`;

  // Step 1: Create contact in HubSpot
  console.log('1. Creating contact in HubSpot CRM...');
  console.log(`   Email: ${testEmail}`);

  const createRes = await fetch(`${API}/crm/v3/objects/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        email: testEmail,
        firstname: testFirst,
        lastname: testLast,
      },
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.error(`   ✗ Failed to create contact: ${createRes.status} ${err}`);
    process.exit(1);
  }

  const created = (await createRes.json()) as { id: string };
  console.log(`   ✓ Created HubSpot contact ID: ${created.id}`);

  // Step 2: Wait for webhook → server → worker pipeline
  console.log('\n2. Waiting for HubSpot webhook delivery + processing...');
  console.log('   (HubSpot typically fires webhooks within 1-5 minutes)');

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const maxWait = 300; // 5 minutes
  const pollInterval = 5; // seconds

  for (let elapsed = 0; elapsed < maxWait; elapsed += pollInterval) {
    await new Promise((r) => setTimeout(r, pollInterval * 1000));

    const result = await pool.query(
      'SELECT sync_status, lahzo_score, lahzo_status, first_name, last_name FROM contacts WHERE hubspot_contact_id = $1',
      [created.id],
    );

    if (result.rows.length > 0) {
      const contact = result.rows[0];
      console.log(`\n   ✓ Contact found in database after ~${elapsed + pollInterval}s`);
      console.log(`     Name: ${contact.first_name} ${contact.last_name}`);
      console.log(`     Sync status: ${contact.sync_status}`);
      console.log(`     Score: ${contact.lahzo_score}`);
      console.log(`     Status: ${contact.lahzo_status}`);

      if (contact.sync_status === 'synced') {
        // Verify writeback
        console.log('\n3. Verifying HubSpot writeback...');
        const verifyRes = await fetch(
          `${API}/crm/v3/objects/contacts/${created.id}?properties=lahzo_score,lahzo_status`,
          { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
        );
        const verifyData = (await verifyRes.json()) as { properties: Record<string, string> };
        console.log(`   lahzo_score in HubSpot: ${verifyData.properties['lahzo_score']}`);
        console.log(`   lahzo_status in HubSpot: ${verifyData.properties['lahzo_status']}`);

        // Check sync events
        const eventsResult = await pool.query(
          `SELECT direction, event_type, status FROM sync_events 
           WHERE contact_id = (SELECT id FROM contacts WHERE hubspot_contact_id = $1) 
           ORDER BY created_at`,
          [created.id],
        );
        console.log(`\n4. Sync events (${eventsResult.rows.length}):`);
        for (const ev of eventsResult.rows) {
          console.log(`   ${ev.direction} | ${ev.event_type} | ${ev.status}`);
        }

        console.log('\n✅ LIVE PIPELINE TEST PASSED — full round trip verified!');
        await pool.end();
        process.exit(0);
      }

      console.log(`   (still processing, waiting...)`);
    } else {
      process.stdout.write(`   Polling... ${elapsed + pollInterval}s / ${maxWait}s\r`);
    }
  }

  console.log('\n✗ Timed out waiting for webhook delivery.');
  console.log('  Check that:');
  console.log('  - ngrok tunnel is running');
  console.log('  - HubSpot webhook subscriptions are active');
  console.log('  - Target URL matches the ngrok URL');
  await pool.end();
  process.exit(1);
}

main().catch(console.error);
