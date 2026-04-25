import * as contactRepo from '../repositories/contact.repository.js';
import { SyncStatus, type Contact } from '../domain/types.js';
import { getAllowedFromStatuses } from '../domain/sync-status.js';
import { InvalidTransitionError, NotFoundError } from '../domain/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Transition a contact's sync_status using the state machine.
 * Returns the updated contact, or throws if the transition is invalid.
 */
export async function transitionStatus(
  contactId: string,
  newStatus: SyncStatus,
  error?: string,
): Promise<void> {
  const allowedFrom = getAllowedFromStatuses(newStatus);
  if (allowedFrom.length === 0) {
    throw new InvalidTransitionError('*', newStatus);
  }

  const updated = await contactRepo.updateSyncStatus(
    contactId,
    newStatus,
    allowedFrom,
    error,
  );

  if (!updated) {
    const contact = await contactRepo.findById(contactId);
    if (!contact) {
      throw new NotFoundError('Contact', contactId);
    }
    throw new InvalidTransitionError(contact.sync_status, newStatus);
  }

  logger.debug({ contactId, newStatus }, 'Contact status transitioned');
}

/**
 * Check if an inbound event is stale (older than what we already have).
 * Uses optimistic concurrency: tries to update the timestamp only if
 * the new event is newer. Returns false if the event is stale.
 */
export async function acceptIfNewer(
  hubspotContactId: string,
  occurredAt: Date,
): Promise<boolean> {
  const updated = await contactRepo.updateTimestampAndStatus(
    hubspotContactId,
    occurredAt,
    SyncStatus.PROCESSING,
  );
  return updated;
}

/**
 * Update contact fields from CRM data.
 */
export async function updateContactFields(
  contactId: string,
  fields: {
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  },
): Promise<void> {
  await contactRepo.updateContactFields(contactId, fields);
}

/**
 * Update contact score and status after enrichment.
 */
export async function updateScore(
  contactId: string,
  score: number,
  status: string,
): Promise<void> {
  await contactRepo.updateScore(contactId, score, status);
}

/**
 * Get a contact by ID, throwing if not found.
 */
export async function getContactOrThrow(contactId: string): Promise<Contact> {
  const contact = await contactRepo.findById(contactId);
  if (!contact) {
    throw new NotFoundError('Contact', contactId);
  }
  return contact;
}

export async function getContacts(
  page: number,
  limit: number,
  statusFilter?: SyncStatus,
): Promise<{ data: Contact[]; total: number }> {
  return contactRepo.findAll(page, limit, statusFilter);
}
