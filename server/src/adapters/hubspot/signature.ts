import crypto from 'node:crypto';

/**
 * Verify HubSpot webhook signature (v2).
 * HubSpot v2 signature = SHA-256(clientSecret + requestBody)
 * Header: x-hubspot-signature
 *
 * @see https://developers.hubspot.com/docs/api/webhooks#security
 */
export function verifySignatureV2(
  clientSecret: string,
  requestBody: string,
  signatureHeader: string,
): boolean {
  const expected = crypto
    .createHash('sha256')
    .update(clientSecret + requestBody)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signatureHeader, 'hex'),
  );
}

/**
 * Verify HubSpot webhook signature (v3).
 * HubSpot v3 signature = HMAC-SHA256(clientSecret, method + url + body + timestamp)
 * Header: x-hubspot-signature-v3
 * Also validates that the timestamp is within 5 minutes.
 *
 * @see https://developers.hubspot.com/docs/api/webhooks#security
 */
export function verifySignatureV3(
  clientSecret: string,
  requestBody: string,
  signatureHeader: string,
  url: string,
  method: string,
  timestamp: string,
): boolean {
  const maxAge = 5 * 60 * 1000;
  const requestTimestamp = parseInt(timestamp, 10) * 1000;
  if (Date.now() - requestTimestamp > maxAge) {
    return false;
  }

  const sourceString = method + url + requestBody + timestamp;
  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(sourceString)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'base64'),
    Buffer.from(signatureHeader, 'base64'),
  );
}
