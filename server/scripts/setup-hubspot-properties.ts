import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const ACCESS_TOKEN = process.env['HUBSPOT_ACCESS_TOKEN']!;
const API = 'https://api.hubapi.com';

const properties = [
  {
    name: 'lahzo_score',
    label: 'Lahzo Score',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'AI-computed lead score from the Lahzo integration platform',
  },
  {
    name: 'lahzo_status',
    label: 'Lahzo Status',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Lead status derived from Lahzo score (hot/warm/cold)',
  },
];

async function main() {
  for (const prop of properties) {
    console.log(`Creating property: ${prop.name}...`);

    const res = await fetch(`${API}/crm/v3/properties/contacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(prop),
    });

    if (res.status === 409) {
      console.log(`  ✓ Already exists`);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(`  ✗ Failed (${res.status}): ${body}`);
      continue;
    }

    console.log(`  ✓ Created`);
  }

  console.log('\n✅ Custom properties ready.');
}

main().catch(console.error);
