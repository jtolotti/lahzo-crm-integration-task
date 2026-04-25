import { getCrmAdapter } from '../adapters/crm.factory.js';
import type { CrmEvent } from '../adapters/crm.interface.js';
import * as rawWebhookRepo from '../repositories/raw-webhook.repository.js';
import * as contactRepo from '../repositories/contact.repository.js';
import * as syncEventRepo from '../repositories/sync-event.repository.js';
import { addSyncJob } from '../queue/sync.queue.js';
import { SyncStatus, EventDirection } from '../domain/types.js';
import { logger } from '../utils/logger.js';

/**
 * Ingest a raw webhook payload:
 * 1. Persist raw payload (durability — nothing lost)
 * 2. Parse into CRM events
 * 3. For each event: upsert contact → create sync_event → enqueue job
 *
 * This runs inside the webhook handler and must complete quickly
 * (HubSpot times out at ~5s). All heavy processing is deferred to the queue.
 */
export async function ingestWebhook(
  payload: unknown,
  headers: Record<string, unknown>,
): Promise<{ accepted: number; duplicates: number }> {
  const rawWebhook = await rawWebhookRepo.insertRawWebhook(payload, headers);
  logger.info({ rawWebhookId: rawWebhook.id }, 'Raw webhook persisted');

  const adapter = getCrmAdapter();
  const events = adapter.parseEvents(payload);

  let accepted = 0;
  let duplicates = 0;

  for (const event of events) {
    try {
      const result = await processEvent(event, rawWebhook.id);
      if (result === 'duplicate') {
        duplicates++;
      } else {
        accepted++;
      }
    } catch (err) {
      logger.error({ err, eventId: event.eventId }, 'Failed to process event during ingestion');
    }
  }

  await rawWebhookRepo.markProcessed(rawWebhook.id);
  logger.info({ rawWebhookId: rawWebhook.id, accepted, duplicates }, 'Webhook ingestion complete');

  return { accepted, duplicates };
}

async function processEvent(
  event: CrmEvent,
  rawWebhookId: string,
): Promise<'accepted' | 'duplicate'> {
  const isDuplicate = await syncEventRepo.existsByHubspotEventId(event.eventId);
  if (isDuplicate) {
    logger.debug({ eventId: event.eventId }, 'Duplicate event, skipping');
    return 'duplicate';
  }

  const contact = await contactRepo.upsertFromEvent(
    event.objectId,
    event.occurredAt,
  );

  const syncEvent = await syncEventRepo.insert({
    contact_id: contact.id,
    hubspot_event_id: event.eventId,
    direction: EventDirection.INBOUND,
    event_type: event.eventType,
    payload: event.rawPayload,
    status: SyncStatus.RECEIVED,
    occurred_at: event.occurredAt,
  });

  const jobId = await addSyncJob({
    syncEventId: syncEvent.id,
    contactId: contact.id,
    rawWebhookId,
    hubspotEventId: event.eventId,
  });

  logger.info(
    { syncEventId: syncEvent.id, contactId: contact.id, jobId, eventType: event.eventType },
    'Event ingested and queued',
  );

  return 'accepted';
}
