import pg from 'pg';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const pool = new pg.Pool({
  connectionString: process.env['DATABASE_URL'] ?? 'postgresql://lahzo:lahzo@localhost:5432/lahzo',
});

interface SeedContact {
  hubspot_contact_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  lahzo_score: number | null;
  lahzo_status: string | null;
  sync_status: string;
  last_error: string | null;
}

const CONTACTS: SeedContact[] = [
  {
    hubspot_contact_id: '90001',
    email: 'maria.santos@acmecorp.com',
    first_name: 'Maria',
    last_name: 'Santos',
    lahzo_score: 95,
    lahzo_status: 'hot',
    sync_status: 'synced',
    last_error: null,
  },
  {
    hubspot_contact_id: '90002',
    email: 'john.doe@bigco.io',
    first_name: 'John',
    last_name: 'Doe',
    lahzo_score: 60,
    lahzo_status: 'warm',
    sync_status: 'synced',
    last_error: null,
  },
  {
    hubspot_contact_id: '90003',
    email: 'jane@gmail.com',
    first_name: 'Jane',
    last_name: 'Smith',
    lahzo_score: 40,
    lahzo_status: 'warm',
    sync_status: 'failed',
    last_error: 'HubSpot API error: 500 — Internal Server Error',
  },
  {
    hubspot_contact_id: '90004',
    email: null,
    first_name: 'Alex',
    last_name: null,
    lahzo_score: null,
    lahzo_status: null,
    sync_status: 'received',
    last_error: null,
  },
  {
    hubspot_contact_id: '90005',
    email: 'chen.wei@startup.dev',
    first_name: 'Chen',
    last_name: 'Wei',
    lahzo_score: 85,
    lahzo_status: 'hot',
    sync_status: 'synced',
    last_error: null,
  },
  {
    hubspot_contact_id: '90006',
    email: 'old-lead@yahoo.com',
    first_name: 'Old',
    last_name: 'Lead',
    lahzo_score: 10,
    lahzo_status: 'cold',
    sync_status: 'skipped_stale',
    last_error: null,
  },
  {
    hubspot_contact_id: '90007',
    email: 'pending@example.com',
    first_name: 'Pat',
    last_name: 'Pending',
    lahzo_score: null,
    lahzo_status: null,
    sync_status: 'processing',
    last_error: null,
  },
  {
    hubspot_contact_id: '90008',
    email: 'retry-me@enterprise.co',
    first_name: 'Retry',
    last_name: 'Case',
    lahzo_score: 72,
    lahzo_status: 'hot',
    sync_status: 'failed',
    last_error: 'CRM rate limit hit, retry after 10000ms',
  },
];

function randomDate(daysAgo: number): Date {
  const now = Date.now();
  return new Date(now - Math.random() * daysAgo * 24 * 60 * 60 * 1000);
}

async function seed() {
  console.log('Seeding demo data...\n');

  // Clean up existing seed data (IDs starting with 9000x)
  await pool.query(`DELETE FROM sync_events WHERE contact_id IN (SELECT id FROM contacts WHERE hubspot_contact_id LIKE '9000%')`);
  await pool.query(`DELETE FROM contacts WHERE hubspot_contact_id LIKE '9000%'`);

  for (const c of CONTACTS) {
    const contactId = randomUUID();
    const occurredAt = randomDate(7);

    await pool.query(
      `INSERT INTO contacts (id, hubspot_contact_id, email, first_name, last_name, lahzo_score, lahzo_status, sync_status, last_error, last_event_occurred_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::sync_status, $9, $10, $11, $12)`,
      [
        contactId, c.hubspot_contact_id, c.email, c.first_name, c.last_name,
        c.lahzo_score, c.lahzo_status, c.sync_status, c.last_error,
        occurredAt, randomDate(14), new Date(),
      ],
    );

    // Inbound event (contact.creation)
    const inboundTime = new Date(occurredAt.getTime() - 1000);
    await pool.query(
      `INSERT INTO sync_events (id, contact_id, hubspot_event_id, direction, event_type, payload, status, occurred_at, processed_at, created_at)
       VALUES ($1, $2, $3, 'inbound', 'contact.creation', $4, $5::sync_status, $6, $7, $8)`,
      [
        randomUUID(), contactId, `seed-${c.hubspot_contact_id}-1`,
        JSON.stringify({ objectId: c.hubspot_contact_id, subscriptionType: 'contact.creation' }),
        c.sync_status === 'received' ? 'received' : c.sync_status === 'processing' ? 'processing' : 'synced',
        inboundTime,
        c.sync_status === 'received' || c.sync_status === 'processing' ? null : new Date(inboundTime.getTime() + 8000),
        inboundTime,
      ],
    );

    // Outbound writeback event (only for synced or failed contacts with score)
    if (c.lahzo_score !== null && (c.sync_status === 'synced' || c.sync_status === 'failed')) {
      const outboundTime = new Date(occurredAt.getTime() + 5000);
      await pool.query(
        `INSERT INTO sync_events (id, contact_id, hubspot_event_id, direction, event_type, payload, status, error_message, occurred_at, processed_at, created_at)
         VALUES ($1, $2, NULL, 'outbound', 'score.writeback', $3, $4::sync_status, $5, $6, $7, $8)`,
        [
          randomUUID(), contactId,
          JSON.stringify({ score: c.lahzo_score, status: c.lahzo_status }),
          c.sync_status === 'synced' ? 'synced' : 'failed',
          c.last_error,
          outboundTime,
          c.sync_status === 'synced' ? outboundTime : null,
          outboundTime,
        ],
      );
    }

    // Extra propertyChange event for some contacts
    if (c.sync_status === 'synced' && c.lahzo_score && c.lahzo_score > 50) {
      const propChangeTime = new Date(occurredAt.getTime() + 60000);
      await pool.query(
        `INSERT INTO sync_events (id, contact_id, hubspot_event_id, direction, event_type, payload, status, occurred_at, processed_at, created_at)
         VALUES ($1, $2, $3, 'inbound', 'contact.propertyChange', $4, 'synced'::sync_status, $5, $6, $7)`,
        [
          randomUUID(), contactId, `seed-${c.hubspot_contact_id}-2`,
          JSON.stringify({ objectId: c.hubspot_contact_id, subscriptionType: 'contact.propertyChange', propertyName: 'email' }),
          propChangeTime,
          new Date(propChangeTime.getTime() + 6000),
          propChangeTime,
        ],
      );
    }

    console.log(`  ✓ ${c.first_name ?? 'Unknown'} ${c.last_name ?? ''} (${c.sync_status})`);
  }

  console.log(`\n✅ Seeded ${CONTACTS.length} contacts with sync events.`);
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
