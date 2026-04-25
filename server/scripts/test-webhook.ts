import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const CLIENT_SECRET = process.env['HUBSPOT_CLIENT_SECRET']!;
const PORTAL_ID = parseInt(process.env['HUBSPOT_PORTAL_ID']!, 10);
const WEBHOOK_URL = 'http://localhost:3000/webhooks/hubspot';

const payload = JSON.stringify([
  {
    objectId: 77777,
    eventId: Date.now(),
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

console.log('Payload:', payload);
console.log('Signature:', signature);
console.log('Sending to:', WEBHOOK_URL);
console.log('---');

const response = await fetch(WEBHOOK_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-hubspot-signature': signature,
  },
  body: payload,
});

const body = await response.json();
console.log('Status:', response.status);
console.log('Response:', JSON.stringify(body, null, 2));

if (response.status === 200 && (body as any).status === 'accepted') {
  console.log('\n✅ Signed webhook test PASSED');
} else {
  console.log('\n❌ Signed webhook test FAILED');
  process.exit(1);
}
