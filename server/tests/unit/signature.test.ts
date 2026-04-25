import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifySignatureV2, verifySignatureV3 } from '../../src/adapters/hubspot/signature.js';

const TEST_SECRET = 'test-client-secret-abc123';

describe('HubSpot signature verification', () => {
  describe('verifySignatureV2', () => {
    it('accepts a valid v2 signature', () => {
      const body = '[{"objectId":123,"eventId":1}]';
      const signature = crypto
        .createHash('sha256')
        .update(TEST_SECRET + body)
        .digest('hex');

      expect(verifySignatureV2(TEST_SECRET, body, signature)).toBe(true);
    });

    it('rejects an incorrect signature', () => {
      const body = '[{"objectId":123,"eventId":1}]';
      const wrongSignature = crypto
        .createHash('sha256')
        .update('wrong-secret' + body)
        .digest('hex');

      expect(verifySignatureV2(TEST_SECRET, body, wrongSignature)).toBe(false);
    });

    it('rejects a signature for a different body', () => {
      const body = '[{"objectId":123,"eventId":1}]';
      const tamperedBody = '[{"objectId":999,"eventId":1}]';
      const signature = crypto
        .createHash('sha256')
        .update(TEST_SECRET + body)
        .digest('hex');

      expect(verifySignatureV2(TEST_SECRET, tamperedBody, signature)).toBe(false);
    });

    it('throws on malformed hex signature (buffer length mismatch)', () => {
      const body = '[]';
      expect(() => verifySignatureV2(TEST_SECRET, body, 'not-hex')).toThrow();
    });
  });

  describe('verifySignatureV3', () => {
    it('accepts a valid v3 signature within timestamp window', () => {
      const body = '[{"objectId":123}]';
      const method = 'POST';
      const url = 'https://example.com/webhooks/hubspot';
      const timestamp = String(Math.floor(Date.now() / 1000));

      const sourceString = method + url + body + timestamp;
      const signature = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(sourceString)
        .digest('base64');

      expect(verifySignatureV3(TEST_SECRET, body, signature, url, method, timestamp)).toBe(true);
    });

    it('rejects an expired timestamp (>5 min old)', () => {
      const body = '[{"objectId":123}]';
      const method = 'POST';
      const url = 'https://example.com/webhooks/hubspot';
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400);

      const sourceString = method + url + body + oldTimestamp;
      const signature = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(sourceString)
        .digest('base64');

      expect(verifySignatureV3(TEST_SECRET, body, signature, url, method, oldTimestamp)).toBe(false);
    });

    it('rejects a wrong signature', () => {
      const body = '[{"objectId":123}]';
      const method = 'POST';
      const url = 'https://example.com/webhooks/hubspot';
      const timestamp = String(Math.floor(Date.now() / 1000));

      const sourceString = method + url + body + timestamp;
      const signature = crypto
        .createHmac('sha256', 'wrong-secret')
        .update(sourceString)
        .digest('base64');

      expect(verifySignatureV3(TEST_SECRET, body, signature, url, method, timestamp)).toBe(false);
    });
  });
});
