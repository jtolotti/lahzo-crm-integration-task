import * as syncEventRepo from '../repositories/sync-event.repository.js';
import * as contactService from './contact.service.js';
import { enrich } from './enrichment.service.js';
import { getCrmAdapter } from '../adapters/crm.factory.js';
import { SyncStatus, EventDirection } from '../domain/types.js';
import { logger } from '../utils/logger.js';

/**
 * Full processing pipeline for a single sync event.
 *
 * Flow:
 * 1. Load sync event
 * 2. Idempotency check (already processed?)
 * 3. Transition contact → processing
 * 4. Stale event check (older than latest?)
 * 5. Fetch contact details from CRM
 * 6. Update local contact fields
 * 7. Enrich (simulated delay + scoring)
 * 8. Write score back to CRM
 * 9. Log outbound sync event
 * 10. Transition contact → synced
 * 11. Mark sync event → synced
 */
export async function processEvent(syncEventId: string): Promise<void> {
  const syncEvent = await syncEventRepo.findById(syncEventId);
  if (!syncEvent) {
    logger.warn({ syncEventId }, 'Sync event not found, skipping');
    return;
  }

  const logCtx = {
    syncEventId,
    contactId: syncEvent.contact_id,
    eventType: syncEvent.event_type,
  };

  // 1. Idempotency: skip if already processed
  if (syncEvent.status === SyncStatus.SYNCED || syncEvent.status === SyncStatus.SKIPPED_STALE) {
    logger.info(logCtx, 'Sync event already processed, skipping');
    return;
  }

  // 2. Transition contact to PROCESSING
  try {
    await contactService.transitionStatus(syncEvent.contact_id, SyncStatus.PROCESSING);
  } catch (err) {
    logger.warn({ ...logCtx, err }, 'Could not transition to processing, may already be in progress');
  }

  // 3. Update sync event status to PROCESSING
  await syncEventRepo.updateStatus(syncEventId, SyncStatus.PROCESSING);

  try {
    // 4. Stale event check
    const contact = await contactService.getContactOrThrow(syncEvent.contact_id);
    if (
      syncEvent.occurred_at &&
      contact.last_event_occurred_at &&
      syncEvent.occurred_at < contact.last_event_occurred_at
    ) {
      logger.info(logCtx, 'Stale event detected, skipping');
      await syncEventRepo.updateStatus(syncEventId, SyncStatus.SKIPPED_STALE, 'Event older than latest');
      await contactService.transitionStatus(syncEvent.contact_id, SyncStatus.SKIPPED_STALE).catch(() => {
        // Contact may have moved on to a newer event, that's fine
      });
      return;
    }

    // 5. Fetch contact from CRM
    const adapter = getCrmAdapter();
    const crmContact = await adapter.fetchContact(
      contact.hubspot_contact_id,
    );
    logger.info({ ...logCtx, email: crmContact.email }, 'Fetched contact from CRM');

    // 6. Update local fields
    await contactService.updateContactFields(syncEvent.contact_id, {
      email: crmContact.email,
      first_name: crmContact.firstName,
      last_name: crmContact.lastName,
    });

    // 7. Enrich (simulated delay + scoring)
    const enrichmentResult = await enrich(crmContact);
    logger.info({ ...logCtx, score: enrichmentResult.score, status: enrichmentResult.status }, 'Enrichment complete');

    // 8. Update local score
    await contactService.updateScore(
      syncEvent.contact_id,
      enrichmentResult.score,
      enrichmentResult.status,
    );

    // 9. Write back to CRM
    const writeResult = await adapter.writebackScore(
      contact.hubspot_contact_id,
      enrichmentResult.score,
      enrichmentResult.status,
    );

    // 10. Log outbound sync event
    await syncEventRepo.insert({
      contact_id: syncEvent.contact_id,
      hubspot_event_id: null,
      direction: EventDirection.OUTBOUND,
      event_type: 'score.writeback',
      payload: {
        score: enrichmentResult.score,
        status: enrichmentResult.status,
        crmResponse: writeResult.response,
      },
      status: writeResult.success ? SyncStatus.SYNCED : SyncStatus.FAILED,
      occurred_at: new Date(),
    });

    if (!writeResult.success) {
      throw new Error(`CRM writeback failed with status ${writeResult.statusCode}`);
    }

    // 11. Transition contact → synced, mark sync event → synced
    await contactService.transitionStatus(syncEvent.contact_id, SyncStatus.SYNCED);
    await syncEventRepo.updateStatus(syncEventId, SyncStatus.SYNCED);

    logger.info(logCtx, 'Sync event fully processed');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ ...logCtx, err: errorMessage }, 'Sync processing failed');

    await syncEventRepo.updateStatus(syncEventId, SyncStatus.FAILED, errorMessage);
    await contactService.transitionStatus(syncEvent.contact_id, SyncStatus.FAILED, errorMessage).catch(() => {
      // Best effort — contact status update might fail if already failed
    });

    throw err;
  }
}
