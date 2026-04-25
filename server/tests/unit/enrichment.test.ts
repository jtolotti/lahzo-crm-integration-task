import { describe, it, expect } from 'vitest';
import { computeScore } from '../../src/services/enrichment.service.js';
import type { CrmContact } from '../../src/adapters/crm.interface.js';

function makeContact(overrides: Partial<CrmContact> = {}): CrmContact {
  return {
    crmContactId: '1',
    email: null,
    firstName: null,
    lastName: null,
    properties: {},
    ...overrides,
  };
}

describe('enrichment scoring', () => {
  it('gives base score of 10 for empty contact', () => {
    const result = computeScore(makeContact());
    expect(result.score).toBe(10);
    expect(result.status).toBe('cold');
  });

  it('adds 30 for having an email', () => {
    const result = computeScore(makeContact({ email: 'test@gmail.com' }));
    expect(result.score).toBe(40);
  });

  it('adds 20 extra for company email domain', () => {
    const result = computeScore(makeContact({ email: 'alice@acme.com' }));
    expect(result.score).toBe(60);
  });

  it('does not add domain bonus for free providers', () => {
    for (const provider of ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com']) {
      const result = computeScore(makeContact({ email: `user@${provider}` }));
      expect(result.score).toBe(40);
    }
  });

  it('adds 15 for first name and 15 for last name', () => {
    const result = computeScore(makeContact({ firstName: 'Alice', lastName: 'Smith' }));
    expect(result.score).toBe(40);
  });

  it('adds 10 for having more than 3 properties', () => {
    const result = computeScore(
      makeContact({
        properties: { a: '1', b: '2', c: '3', d: '4' },
      }),
    );
    expect(result.score).toBe(20);
  });

  it('returns "hot" for score >= 70', () => {
    const result = computeScore(
      makeContact({
        email: 'alice@acme.com',
        firstName: 'Alice',
        lastName: 'Smith',
      }),
    );
    expect(result.score).toBe(90);
    expect(result.status).toBe('hot');
  });

  it('returns "warm" for score >= 40 and < 70', () => {
    const result = computeScore(
      makeContact({
        email: 'user@gmail.com',
        firstName: 'Bob',
      }),
    );
    expect(result.score).toBe(55);
    expect(result.status).toBe('warm');
  });

  it('returns "cold" for score < 40', () => {
    const result = computeScore(makeContact({ firstName: 'Only' }));
    expect(result.score).toBe(25);
    expect(result.status).toBe('cold');
  });
});
