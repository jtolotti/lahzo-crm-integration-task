import type { FastifyRequest } from 'fastify';
import type { CrmAdapter, CrmEvent, CrmContact, WritebackResult } from '../crm.interface.js';
import { logger } from '../../utils/logger.js';
import { waitForToken } from '../../utils/rate-limiter.js';

/**
 * Salesforce CRM Adapter — demonstrates how a second CRM plugs into the
 * same pipeline by implementing the CrmAdapter interface.
 *
 * The core pipeline (ingestion → queue → worker → sync events → operator UI)
 * requires zero changes. Only this adapter + its field mapping differ.
 *
 * Implementation notes for production:
 * - Auth: OAuth 2.0 JWT Bearer flow for server-to-server. Token refresh handled
 *   transparently by the adapter (cache access_token, refresh on 401).
 * - Webhooks: Salesforce doesn't have native webhook subscriptions like HubSpot.
 *   Options: Platform Events, Change Data Capture (CDC), or Apex callouts.
 *   CDC is the closest analog — subscribe via CometD/Pub/Sub API for real-time
 *   Lead/Contact change streams.
 * - Rate limits: Salesforce enforces daily API call limits (~15k–100k depending
 *   on edition) rather than per-second burst limits. The rate limiter window
 *   would shift from 10s sliding window to a daily counter.
 * - Field mapping: Salesforce uses "Name" (compound), "Email", "Phone" etc.
 *   Custom fields use __c suffix (e.g., Lahzo_Score__c, Lahzo_Status__c).
 */

const SF_API_VERSION = 'v59.0';

export class SalesforceAdapter implements CrmAdapter {
  constructor(
    private readonly instanceUrl: string,
    private readonly accessToken: string,
  ) {}

  /**
   * Validate inbound Salesforce webhook/CDC event.
   *
   * Salesforce CDC events arrive via Pub/Sub API (gRPC) or CometD streaming,
   * not as HTTP webhooks. For Apex callout webhooks, validation would use
   * a shared secret in a custom header or IP allowlisting.
   */
  validateWebhook(_request: FastifyRequest): boolean {
    // For Apex callouts: verify a shared HMAC token in a custom header.
    // For CDC: events arrive over an authenticated streaming connection
    //          (already trusted), so validation is implicit.
    //
    // const secret = request.headers['x-sf-webhook-secret'];
    // return secret === this.webhookSecret;

    logger.warn('SalesforceAdapter.validateWebhook: not implemented — stub');
    return false;
  }

  /**
   * Parse Salesforce event payload into normalized CrmEvents.
   *
   * CDC payloads differ significantly from HubSpot:
   * {
   *   "ChangeEventHeader": {
   *     "entityName": "Contact",
   *     "changeType": "CREATE" | "UPDATE",
   *     "recordIds": ["003xx000004TdOaAAK"],
   *     "commitTimestamp": 1691234567000,
   *     "changeOrigin": "com/salesforce/api/rest/..."
   *   },
   *   "FirstName": { "string": "John" },
   *   "LastName": { "string": "Doe" },
   *   "Email": { "string": "john@example.com" }
   * }
   *
   * The mapper would normalize these into CrmEvent objects with:
   * - eventId: derived from replayId or commitTimestamp + recordId
   * - objectId: recordIds[0]
   * - eventType: "Contact.CREATE" or "Contact.UPDATE"
   * - occurredAt: commitTimestamp
   */
  parseEvents(_payload: unknown): CrmEvent[] {
    // const cdcEvent = payload as SalesforceCdcEvent;
    // const header = cdcEvent.ChangeEventHeader;
    // return header.recordIds.map((recordId) => ({
    //   eventId: `${header.commitTimestamp}-${recordId}`,
    //   objectId: recordId,
    //   eventType: `${header.entityName}.${header.changeType}`,
    //   occurredAt: new Date(header.commitTimestamp),
    //   rawPayload: cdcEvent,
    // }));

    logger.warn('SalesforceAdapter.parseEvents: not implemented — stub');
    return [];
  }

  /**
   * Fetch a Contact/Lead from Salesforce REST API.
   *
   * GET /services/data/vXX.0/sobjects/Contact/{id}
   * ?fields=FirstName,LastName,Email
   *
   * Field mapping:
   * | Salesforce Field  | Internal Field |
   * |-------------------|----------------|
   * | Id                | hubspot_contact_id (crm_contact_id in multi-CRM) |
   * | FirstName         | first_name     |
   * | LastName          | last_name      |
   * | Email             | email          |
   * | Lahzo_Score__c    | lahzo_score    |
   * | Lahzo_Status__c   | lahzo_status   |
   */
  async fetchContact(contactId: string): Promise<CrmContact> {
    await waitForToken();

    const url = `${this.instanceUrl}/services/data/${SF_API_VERSION}/sobjects/Contact/${contactId}?fields=FirstName,LastName,Email`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Salesforce API error: ${response.status} — ${body}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const properties: Record<string, string> = {};
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === 'string') properties[key] = val;
    }
    return {
      crmContactId: contactId,
      email: (data['Email'] as string) ?? null,
      firstName: (data['FirstName'] as string) ?? null,
      lastName: (data['LastName'] as string) ?? null,
      properties,
    };
  }

  /**
   * Write lahzo_score and lahzo_status back to the Salesforce contact
   * as custom fields (Lahzo_Score__c, Lahzo_Status__c).
   *
   * PATCH /services/data/vXX.0/sobjects/Contact/{id}
   * Body: { "Lahzo_Score__c": 85, "Lahzo_Status__c": "hot" }
   *
   * Salesforce PATCH returns 204 No Content on success.
   */
  async writebackScore(
    contactId: string,
    score: number,
    status: string,
  ): Promise<WritebackResult> {
    await waitForToken();

    const url = `${this.instanceUrl}/services/data/${SF_API_VERSION}/sobjects/Contact/${contactId}`;
    const body = {
      Lahzo_Score__c: score,
      Lahzo_Status__c: status,
    };

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Salesforce returns 204 No Content on successful PATCH
    return {
      success: response.status === 204 || response.ok,
      statusCode: response.status,
      response: response.status === 204 ? {} : await response.json() as Record<string, unknown>,
    };
  }
}
