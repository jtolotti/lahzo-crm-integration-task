export enum SyncStatus {
  RECEIVED = 'received',
  PROCESSING = 'processing',
  SYNCED = 'synced',
  FAILED = 'failed',
  SKIPPED_STALE = 'skipped_stale',
}

export enum EventDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

export enum UserRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
}

export interface Contact {
  id: string;
  hubspot_contact_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  lahzo_score: number | null;
  lahzo_status: string | null;
  sync_status: SyncStatus;
  last_error: string | null;
  last_event_occurred_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface SyncEvent {
  id: string;
  contact_id: string;
  hubspot_event_id: string | null;
  direction: EventDirection;
  event_type: string;
  payload: Record<string, unknown>;
  status: SyncStatus;
  error_message: string | null;
  occurred_at: Date | null;
  processed_at: Date | null;
  created_at: Date;
}

export interface RawWebhook {
  id: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  received_at: Date;
  processed: boolean;
}

export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: UserRole;
  created_at: Date;
}

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
