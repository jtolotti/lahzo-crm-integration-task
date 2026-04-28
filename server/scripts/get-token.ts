/**
 * Utility for scripts to get a valid HubSpot access token.
 * Reads from the token file and refreshes if expired.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, '../.hubspot-tokens.json');
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function getScriptAccessToken(): Promise<string> {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error(
      'No HubSpot tokens found. Start the server and visit http://localhost:3000/hubspot/auth to authorize first.',
    );
  }

  const tokens: StoredTokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));

  if (Date.now() < tokens.expiresAt - EXPIRY_BUFFER_MS) {
    return tokens.accessToken;
  }

  // Token expired — refresh it
  const clientId = process.env['HUBSPOT_CLIENT_ID']!;
  const clientSecret = process.env['HUBSPOT_CLIENT_SECRET']!;

  console.log('Access token expired, refreshing...');

  const res = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  fs.writeFileSync(TOKEN_FILE, JSON.stringify(updated, null, 2));
  console.log('Token refreshed successfully.');
  return updated.accessToken;
}
