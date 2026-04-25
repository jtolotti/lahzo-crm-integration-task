import type { FastifyRequest } from 'fastify';
import type { CrmAdapter, CrmEvent, CrmContact, WritebackResult } from '../crm.interface.js';
import type { HubSpotWebhookEvent, HubSpotContactResponse } from './types.js';
import { toInternalEvent, toInternalContact, toHubSpotProperties } from './mapper.js';
import { verifySignatureV2 } from './signature.js';
import { waitForToken } from '../../utils/rate-limiter.js';
import { RateLimitError, TransientCrmError } from '../../domain/errors.js';
import { logger } from '../../utils/logger.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

/**
 * Throw a typed error based on the CRM API response status.
 * - 429: RateLimitError with Retry-After header support
 * - 5xx: TransientCrmError (BullMQ will retry with backoff)
 * - Other: generic Error
 */
function throwCrmError(response: Response, body: string): never {
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10000;
    throw new RateLimitError(retryMs);
  }

  if (response.status >= 500) {
    throw new TransientCrmError(response.status, body);
  }

  throw new Error(`CRM API error: ${response.status} — ${body}`);
}

export class HubSpotAdapter implements CrmAdapter {
  constructor(
    private readonly accessToken: string,
    private readonly clientSecret: string,
  ) {}

  /**
   * Validate the webhook request signature using v2 verification.
   */
  validateWebhook(request: FastifyRequest): boolean {
    const signature = request.headers['x-hubspot-signature'] as string | undefined;
    if (!signature) {
      logger.warn('Missing x-hubspot-signature header');
      return false;
    }

    const rawBody = (request as any).rawBody as string;
    if (!rawBody) {
      logger.warn('Missing raw body for signature verification');
      return false;
    }

    try {
      const valid = verifySignatureV2(this.clientSecret, rawBody, signature);
      if (!valid) {
        logger.warn('Webhook signature mismatch');
      }
      return valid;
    } catch (err) {
      logger.error({ err }, 'Signature verification error');
      return false;
    }
  }

  /**
   * Parse HubSpot webhook payload (array of events) into normalized CrmEvents.
   */
  parseEvents(payload: unknown): CrmEvent[] {
    if (!Array.isArray(payload)) {
      logger.warn({ payload: typeof payload }, 'Expected array payload from HubSpot webhook');
      return [];
    }

    return (payload as HubSpotWebhookEvent[]).map(toInternalEvent);
  }

  /**
   * Fetch a contact from HubSpot CRM v3 API.
   */
  async fetchContact(contactId: string): Promise<CrmContact> {
    await waitForToken();

    const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}?properties=email,firstname,lastname`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error({ statusCode: response.status, body, contactId }, 'HubSpot fetchContact failed');
      throwCrmError(response, body);
    }

    const data = (await response.json()) as HubSpotContactResponse;
    return toInternalContact(data);
  }

  /**
   * Write lahzo_score and lahzo_status back to the HubSpot contact.
   */
  async writebackScore(
    contactId: string,
    score: number,
    status: string,
  ): Promise<WritebackResult> {
    await waitForToken();

    const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`;
    const body = toHubSpotProperties(score, status);

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseBody = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      logger.error(
        { statusCode: response.status, body: responseBody, contactId },
        'HubSpot writebackScore failed',
      );

      if (response.status === 429 || response.status >= 500) {
        throwCrmError(response, JSON.stringify(responseBody));
      }
    } else {
      logger.info({ contactId, score, status }, 'Score written back to HubSpot');
    }

    return {
      success: response.ok,
      statusCode: response.status,
      response: responseBody,
    };
  }
}
