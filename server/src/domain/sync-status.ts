import { SyncStatus } from './types.js';

/**
 * Directed state machine for sync_status transitions.
 * Maps each status to the list of statuses it is allowed to transition TO.
 */
const ALLOWED_TRANSITIONS: Record<SyncStatus, SyncStatus[]> = {
  [SyncStatus.RECEIVED]:      [SyncStatus.PROCESSING, SyncStatus.SKIPPED_STALE],
  [SyncStatus.PROCESSING]:    [SyncStatus.SYNCED, SyncStatus.FAILED],
  [SyncStatus.SYNCED]:        [SyncStatus.PROCESSING],
  [SyncStatus.FAILED]:        [SyncStatus.PROCESSING],
  [SyncStatus.SKIPPED_STALE]: [],
};

/**
 * Check if a transition from one status to another is allowed.
 */
export function canTransition(from: SyncStatus, to: SyncStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Get the list of statuses that are allowed to transition TO the given status.
 * Used in SQL WHERE clauses: `sync_status = ANY($allowedFrom)`.
 */
export function getAllowedFromStatuses(to: SyncStatus): SyncStatus[] {
  const allowed: SyncStatus[] = [];
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    if (targets.includes(to)) {
      allowed.push(from as SyncStatus);
    }
  }
  return allowed;
}
