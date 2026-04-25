import { describe, it, expect } from 'vitest';
import { SyncStatus } from '../../src/domain/types.js';
import { canTransition, getAllowedFromStatuses } from '../../src/domain/sync-status.js';

describe('sync-status state machine', () => {
  describe('canTransition', () => {
    const validTransitions: [SyncStatus, SyncStatus][] = [
      [SyncStatus.RECEIVED, SyncStatus.PROCESSING],
      [SyncStatus.RECEIVED, SyncStatus.SKIPPED_STALE],
      [SyncStatus.PROCESSING, SyncStatus.SYNCED],
      [SyncStatus.PROCESSING, SyncStatus.FAILED],
      [SyncStatus.SYNCED, SyncStatus.PROCESSING],
      [SyncStatus.FAILED, SyncStatus.PROCESSING],
    ];

    it.each(validTransitions)(
      'allows %s → %s',
      (from, to) => {
        expect(canTransition(from, to)).toBe(true);
      },
    );

    const invalidTransitions: [SyncStatus, SyncStatus][] = [
      [SyncStatus.RECEIVED, SyncStatus.SYNCED],
      [SyncStatus.RECEIVED, SyncStatus.FAILED],
      [SyncStatus.PROCESSING, SyncStatus.RECEIVED],
      [SyncStatus.PROCESSING, SyncStatus.SKIPPED_STALE],
      [SyncStatus.SYNCED, SyncStatus.FAILED],
      [SyncStatus.SYNCED, SyncStatus.RECEIVED],
      [SyncStatus.SYNCED, SyncStatus.SKIPPED_STALE],
      [SyncStatus.FAILED, SyncStatus.SYNCED],
      [SyncStatus.FAILED, SyncStatus.RECEIVED],
      [SyncStatus.FAILED, SyncStatus.SKIPPED_STALE],
      [SyncStatus.SKIPPED_STALE, SyncStatus.RECEIVED],
      [SyncStatus.SKIPPED_STALE, SyncStatus.PROCESSING],
      [SyncStatus.SKIPPED_STALE, SyncStatus.SYNCED],
      [SyncStatus.SKIPPED_STALE, SyncStatus.FAILED],
    ];

    it.each(invalidTransitions)(
      'blocks %s → %s',
      (from, to) => {
        expect(canTransition(from, to)).toBe(false);
      },
    );
  });

  describe('getAllowedFromStatuses', () => {
    it('returns correct sources for PROCESSING', () => {
      const sources = getAllowedFromStatuses(SyncStatus.PROCESSING);
      expect(sources).toEqual(
        expect.arrayContaining([SyncStatus.RECEIVED, SyncStatus.SYNCED, SyncStatus.FAILED]),
      );
      expect(sources).toHaveLength(3);
    });

    it('returns correct sources for SYNCED', () => {
      const sources = getAllowedFromStatuses(SyncStatus.SYNCED);
      expect(sources).toEqual([SyncStatus.PROCESSING]);
    });

    it('returns correct sources for SKIPPED_STALE', () => {
      const sources = getAllowedFromStatuses(SyncStatus.SKIPPED_STALE);
      expect(sources).toEqual([SyncStatus.RECEIVED]);
    });

    it('returns empty for RECEIVED (no status transitions to received)', () => {
      const sources = getAllowedFromStatuses(SyncStatus.RECEIVED);
      expect(sources).toEqual([]);
    });
  });
});
