/**
 * Shape of a single event in a HubSpot webhook batch.
 * HubSpot sends an array of these in the POST body.
 * @see https://developers.hubspot.com/docs/api/webhooks
 */
export interface HubSpotWebhookEvent {
  objectId: number;
  propertyName?: string;
  propertyValue?: string;
  changeSource: string;
  eventId: number;
  subscriptionId: number;
  portalId: number;
  appId: number;
  occurredAt: number;
  subscriptionType: string;
  attemptNumber: number;
  objectTypeId?: string;
  changeFlag?: string;
}

/**
 * Shape of the HubSpot CRM v3 Contact response.
 */
export interface HubSpotContactResponse {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/**
 * Shape of the HubSpot CRM v3 PATCH response.
 */
export interface HubSpotUpdateResponse {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}
