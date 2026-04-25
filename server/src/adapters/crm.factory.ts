import { config } from '../config.js';
import type { CrmAdapter } from './crm.interface.js';
import { HubSpotAdapter } from './hubspot/adapter.js';

let adapter: CrmAdapter | null = null;

/**
 * Get the CRM adapter singleton.
 * Currently always returns HubSpotAdapter — the factory pattern
 * makes it easy to swap for a mock or another CRM in the future.
 */
export function getCrmAdapter(): CrmAdapter {
  if (!adapter) {
    adapter = new HubSpotAdapter(
      config.HUBSPOT_ACCESS_TOKEN,
      config.HUBSPOT_CLIENT_SECRET,
    );
  }
  return adapter;
}
