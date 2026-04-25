import type { CrmEvent, CrmContact } from '../crm.interface.js';
import type { HubSpotWebhookEvent, HubSpotContactResponse } from './types.js';

/**
 * Convert a HubSpot webhook event into a normalized CrmEvent.
 */
export function toInternalEvent(event: HubSpotWebhookEvent): CrmEvent {
  return {
    eventId: String(event.eventId),
    objectId: String(event.objectId),
    eventType: event.subscriptionType,
    propertyName: event.propertyName ?? null,
    propertyValue: event.propertyValue ?? null,
    occurredAt: new Date(event.occurredAt),
    rawPayload: event as unknown as Record<string, unknown>,
  };
}

/**
 * Convert a HubSpot API contact response into a normalized CrmContact.
 */
export function toInternalContact(response: HubSpotContactResponse): CrmContact {
  return {
    crmContactId: response.id,
    email: response.properties['email'] ?? null,
    firstName: response.properties['firstname'] ?? null,
    lastName: response.properties['lastname'] ?? null,
    properties: Object.fromEntries(
      Object.entries(response.properties)
        .filter(([, v]) => v !== null) as [string, string][],
    ),
  };
}

/**
 * Convert internal score and status into HubSpot property format
 * for the PATCH request body.
 */
export function toHubSpotProperties(
  score: number,
  status: string,
): { properties: Record<string, string> } {
  return {
    properties: {
      lahzo_score: String(score),
      lahzo_status: status,
    },
  };
}
