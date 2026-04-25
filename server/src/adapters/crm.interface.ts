import type { FastifyRequest } from 'fastify';

export interface CrmEvent {
  eventId: string;
  objectId: string;
  eventType: string;
  propertyName: string | null;
  propertyValue: string | null;
  occurredAt: Date;
  rawPayload: Record<string, unknown>;
}

export interface CrmContact {
  crmContactId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  properties: Record<string, string>;
}

export interface WritebackResult {
  success: boolean;
  statusCode: number;
  response: Record<string, unknown>;
}

export interface CrmAdapter {
  /**
   * Validate the webhook request signature.
   * Returns true if the signature is valid.
   */
  validateWebhook(request: FastifyRequest): boolean;

  /**
   * Parse a raw webhook payload into normalized CRM events.
   */
  parseEvents(payload: unknown): CrmEvent[];

  /**
   * Fetch a contact from the CRM by its CRM-side ID.
   */
  fetchContact(contactId: string): Promise<CrmContact>;

  /**
   * Write score and status back to the CRM contact.
   */
  writebackScore(
    contactId: string,
    score: number,
    status: string,
  ): Promise<WritebackResult>;
}
