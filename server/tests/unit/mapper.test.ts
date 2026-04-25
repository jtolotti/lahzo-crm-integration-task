import { describe, it, expect } from 'vitest';
import { toInternalEvent, toInternalContact, toHubSpotProperties } from '../../src/adapters/hubspot/mapper.js';
import type { HubSpotWebhookEvent, HubSpotContactResponse } from '../../src/adapters/hubspot/types.js';

describe('HubSpot mapper', () => {
  describe('toInternalEvent', () => {
    it('maps a contact.creation event', () => {
      const raw: HubSpotWebhookEvent = {
        objectId: 12345,
        changeSource: 'CRM',
        eventId: 100,
        subscriptionId: 1,
        portalId: 12345678,
        appId: 1,
        occurredAt: 1700000000000,
        subscriptionType: 'contact.creation',
        attemptNumber: 0,
      };

      const result = toInternalEvent(raw);

      expect(result.eventId).toBe('100');
      expect(result.objectId).toBe('12345');
      expect(result.eventType).toBe('contact.creation');
      expect(result.propertyName).toBeNull();
      expect(result.propertyValue).toBeNull();
      expect(result.occurredAt).toEqual(new Date(1700000000000));
      expect(result.rawPayload).toEqual(raw);
    });

    it('maps a contact.propertyChange event with property details', () => {
      const raw: HubSpotWebhookEvent = {
        objectId: 67890,
        propertyName: 'email',
        propertyValue: 'test@example.com',
        changeSource: 'CRM_UI',
        eventId: 200,
        subscriptionId: 2,
        portalId: 12345678,
        appId: 1,
        occurredAt: 1700000001000,
        subscriptionType: 'contact.propertyChange',
        attemptNumber: 0,
      };

      const result = toInternalEvent(raw);

      expect(result.eventId).toBe('200');
      expect(result.objectId).toBe('67890');
      expect(result.eventType).toBe('contact.propertyChange');
      expect(result.propertyName).toBe('email');
      expect(result.propertyValue).toBe('test@example.com');
    });
  });

  describe('toInternalContact', () => {
    it('maps a full contact response', () => {
      const response: HubSpotContactResponse = {
        id: '99999',
        properties: {
          email: 'alice@corp.com',
          firstname: 'Alice',
          lastname: 'Smith',
          company: 'Acme Inc',
        },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-06-15T12:00:00Z',
        archived: false,
      };

      const result = toInternalContact(response);

      expect(result.crmContactId).toBe('99999');
      expect(result.email).toBe('alice@corp.com');
      expect(result.firstName).toBe('Alice');
      expect(result.lastName).toBe('Smith');
      expect(result.properties).toEqual({
        email: 'alice@corp.com',
        firstname: 'Alice',
        lastname: 'Smith',
        company: 'Acme Inc',
      });
    });

    it('handles null properties gracefully', () => {
      const response: HubSpotContactResponse = {
        id: '11111',
        properties: {
          email: null,
          firstname: null,
          lastname: null,
        },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        archived: false,
      };

      const result = toInternalContact(response);

      expect(result.email).toBeNull();
      expect(result.firstName).toBeNull();
      expect(result.lastName).toBeNull();
      expect(result.properties).toEqual({});
    });
  });

  describe('toHubSpotProperties', () => {
    it('formats score and status for PATCH request', () => {
      const result = toHubSpotProperties(85, 'hot');

      expect(result).toEqual({
        properties: {
          lahzo_score: '85',
          lahzo_status: 'hot',
        },
      });
    });
  });
});
