import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, '../../../.hubspot-tokens.json');
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

// Refresh 5 minutes before actual expiry to avoid mid-request failures
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let cached: StoredTokens | null = null;

/**
 * Load tokens from disk. Returns null if no tokens file exists.
 */
function loadFromDisk(): StoredTokens | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) as StoredTokens;
    return data;
  } catch {
    logger.warn('Failed to read token file, re-authorization required');
    return null;
  }
}

/**
 * Persist tokens to disk so they survive server restarts.
 */
function saveToDisk(tokens: StoredTokens): void {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Exchange an authorization code for access + refresh tokens (initial OAuth step).
 */
export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<StoredTokens> {
  const res = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokens: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  cached = tokens;
  saveToDisk(tokens);
  logger.info('HubSpot OAuth tokens acquired and saved');
  return tokens;
}

/**
 * Refresh the access token using the stored refresh token.
 */
async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<StoredTokens> {
  const current = cached ?? loadFromDisk();
  if (!current?.refreshToken) {
    throw new Error('No refresh token available — re-authorize at /hubspot/auth');
  }

  const res = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: current.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokens: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  cached = tokens;
  saveToDisk(tokens);
  logger.info('HubSpot OAuth token refreshed');
  return tokens;
}

/**
 * Get a valid access token, refreshing automatically if expired.
 */
export async function getAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  if (!cached) {
    cached = loadFromDisk();
  }

  if (!cached) {
    throw new Error('Not authorized — visit /hubspot/auth to connect your HubSpot account');
  }

  // Refresh if token is expired or about to expire
  if (Date.now() >= cached.expiresAt - EXPIRY_BUFFER_MS) {
    cached = await refreshAccessToken(clientId, clientSecret);
  }

  return cached.accessToken;
}

/**
 * Check if tokens are available (authorized).
 */
export function isAuthorized(): boolean {
  if (!cached) {
    cached = loadFromDisk();
  }
  return cached !== null;
}
