import type { CrmContact } from '../adapters/crm.interface.js';

export interface EnrichmentResult {
  score: number;
  status: string;
}

/**
 * Compute a deterministic score based on contact properties.
 * Pure function — no I/O, no randomness. Easy to test.
 *
 * Scoring logic:
 * - Base score: 10
 * - Has email: +30
 * - Has first name: +15
 * - Has last name: +15
 * - Email is from a company domain (not gmail/yahoo/hotmail): +20
 * - Has more than 3 properties: +10
 */
export function computeScore(contact: CrmContact): EnrichmentResult {
  let score = 10;

  if (contact.email) {
    score += 30;

    const domain = contact.email.split('@')[1]?.toLowerCase() ?? '';
    const freeProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com'];
    if (domain && !freeProviders.includes(domain)) {
      score += 20;
    }
  }

  if (contact.firstName) score += 15;
  if (contact.lastName) score += 15;

  if (Object.keys(contact.properties).length > 3) {
    score += 10;
  }

  const status = score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';

  return { score, status };
}

/**
 * Simulated enrichment with a 3–15 second delay.
 * In production, this would call an external enrichment API.
 */
export async function enrich(contact: CrmContact): Promise<EnrichmentResult> {
  const delay = 3000 + Math.random() * 12000;
  await new Promise((resolve) => setTimeout(resolve, delay));

  return computeScore(contact);
}
