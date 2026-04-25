# Implementation Plan

This document defines the exact build order, code patterns, dependencies, database schema (full SQL), frontend structure, and testing approach. Each phase builds on the previous — nothing is written that can't be immediately run or tested.

---

## Code Patterns & Conventions

### Architectural layers

```
Routes (HTTP boundary)
  ↓ receives request, validates, delegates
Services (business logic)
  ↓ orchestrates operations, enforces rules
Repositories (data access)
  ↓ raw SQL queries, returns typed objects
Database (PostgreSQL) / Queue (BullMQ) / Cache (Redis)
```

**Rules:**
- Routes never access the database directly — they call services.
- Services never construct SQL — they call repositories.
- Repositories are pure data access — no business logic, no HTTP concepts.
- The CRM adapter is injected into services, never imported directly by routes or repositories.

### Patterns used

| Pattern | Where | Why |
|---|---|---|
| **Repository** | `repositories/*.ts` | Isolates SQL from business logic. Makes testing trivial — mock the repository, not the database. |
| **Service layer** | `services/*.ts` | Single place for business rules (state machine, idempotency, orchestration). Routes stay thin. |
| **Adapter** | `adapters/crm.interface.ts` + `adapters/hubspot/` | Decouples CRM-specific logic from the core pipeline. Swap CRMs by swapping adapter. |
| **State machine** | `domain/sync-status.ts` | Pure function defining allowed transitions. Used by services, tested independently. |
| **Factory** | `adapters/crm.factory.ts` | Returns the correct CRM adapter based on config. Extensibility point for multi-CRM. |
| **Dependency injection (manual)** | Constructor params, not a DI framework | Services receive repositories and adapters as params at bootstrap time. Keeps it simple, testable, no magic. |

### Naming conventions

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Variables/functions: `camelCase`
- Database columns: `snake_case`
- Enum-like constants: `UPPER_SNAKE_CASE` (or TypeScript `enum`)
- Test files: `*.test.ts` (colocated in `tests/` mirror structure)

### Error handling

- Fastify's built-in `setErrorHandler` for global HTTP error handling.
- Domain errors extend a base `AppError` class with `statusCode` and `code` fields.
- Worker errors are caught, logged, and stored in `sync_events.error_message` — never silently swallowed.
- All async operations wrapped in try/catch with structured logging.

---

## Dependencies

### Server (`server/package.json`)

| Package | Purpose |
|---|---|
| `fastify` | HTTP framework |
| `@fastify/cors` | CORS for frontend dev server |
| `pg` | PostgreSQL client (raw SQL, no ORM) |
| `bullmq` | Job queue |
| `ioredis` | Redis client (shared by BullMQ and idempotency cache) |
| `zod` | Runtime validation for webhook payloads, env config, API params |
| `dotenv` | Load `.env` file |
| `pino-pretty` | Dev-friendly log formatting (pino comes built into Fastify) |
| `bcrypt` | Password hashing (12 salt rounds) |
| `jsonwebtoken` | JWT token signing and verification |
| `@types/bcrypt`, `@types/jsonwebtoken` | Type definitions |
| `tsx` | Dev runner — run TypeScript directly without build step |
| `typescript` | Type system |
| `vitest` | Test runner |
| `@types/pg` | Type definitions |

**Why `pg` and not Prisma/Knex/Kysely?** Raw SQL with typed helpers keeps the repository layer transparent. In an integration service, the SQL queries are few and specific (upserts with WHERE clauses, JSONB inserts). An ORM would add abstraction without reducing complexity. The queries are the business logic — they should be visible.

### Web (`web/package.json`)

| Package | Purpose |
|---|---|
| `react`, `react-dom` | UI framework |
| `react-router-dom` | Client-side routing (list → detail) |
| `@tanstack/react-query` | Server state management — auto-refetch, loading/error states |
| `tailwindcss`, `@tailwindcss/vite` | Utility CSS — structured without writing custom CSS |
| `vite` | Build tool + dev server |
| `typescript` | Type system |
| `js-cookie` | Cookie-based token persistence (optional, can use localStorage) |

---

## Database: Full SQL Migration

File: `server/src/db/migrations/001_initial.sql`

```sql
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enum types
CREATE TYPE sync_status AS ENUM (
  'received',
  'processing',
  'synced',
  'failed',
  'skipped_stale'
);

CREATE TYPE event_direction AS ENUM (
  'inbound',
  'outbound'
);

-- Raw webhook payloads (immutable append-only log)
CREATE TABLE raw_webhooks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload        JSONB NOT NULL,
  headers        JSONB NOT NULL DEFAULT '{}',
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_raw_webhooks_unprocessed
  ON raw_webhooks (received_at)
  WHERE processed = FALSE;

-- Contacts (materialized internal state)
CREATE TABLE contacts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hubspot_contact_id      VARCHAR(255) NOT NULL UNIQUE,
  email                   VARCHAR(255),
  first_name              VARCHAR(255),
  last_name               VARCHAR(255),
  lahzo_score             INTEGER,
  lahzo_status            VARCHAR(50),
  sync_status             sync_status NOT NULL DEFAULT 'received',
  last_error              TEXT,
  last_event_occurred_at  TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contacts_sync_status ON contacts (sync_status);

-- Sync events (full audit trail)
CREATE TABLE sync_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  hubspot_event_id  VARCHAR(255) UNIQUE,
  direction         event_direction NOT NULL,
  event_type        VARCHAR(100) NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}',
  status            sync_status NOT NULL DEFAULT 'received',
  error_message     TEXT,
  occurred_at       TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_events_contact_history
  ON sync_events (contact_id, created_at DESC);

CREATE INDEX idx_sync_events_status
  ON sync_events (status)
  WHERE status IN ('failed', 'processing');

-- Operator users (authentication)
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  name           VARCHAR(255) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

File: `server/src/db/migrations/002_seed_users.sql`

```sql
-- Seed operator accounts (passwords hashed with bcrypt, 12 rounds)
-- admin@lahzo.dev / admin123
-- reviewer@lahzo.dev / reviewer123
-- Hashes are pre-computed so the migration is pure SQL with no runtime dependency.
INSERT INTO users (email, password_hash, name) VALUES
  ('admin@lahzo.dev',    '$2b$12$LJ3m4ys3Lk0TDcfejPMqpOSYqMGEBJqn0ZQ8v5Y9K.Wg5RYdW5X2G', 'Admin'),
  ('reviewer@lahzo.dev', '$2b$12$8Kx3x5Y2Lk0TDcfejPMqpORRqMGEBJqn0ZQ8v5Y9K.Wg5RYdW5X2G', 'Reviewer')
ON CONFLICT (email) DO NOTHING;
```

> **Note:** The bcrypt hashes above are placeholders. During Phase 1 implementation, we'll generate real hashes using a small script (`npx tsx scripts/hash-password.ts admin123`) and update the migration.

### Migration runner

A simple sequential runner: reads `.sql` files from the migrations folder in order, tracks applied migrations in a `_migrations` table, skips already-applied ones. No external migration tool dependency — keeps it self-contained.

---

## Detailed Project Structure

```
lahzo/
├── ARCHITECTURE.md
├── IMPLEMENTATION_PLAN.md
├── README.md
├── docker-compose.yml
├── .env
├── .env.example
├── .gitignore
│
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   │
│   ├── src/
│   │   ├── index.ts                        # Bootstrap: create server, register plugins/routes, start worker, listen
│   │   ├── config.ts                       # Zod-validated env parsing → typed Config object
│   │   │
│   │   ├── domain/                         # Pure domain logic — no I/O, no dependencies
│   │   │   ├── types.ts                    # Core types: Contact, SyncEvent, RawWebhook, SyncStatus, EventDirection
│   │   │   ├── sync-status.ts              # State machine: ALLOWED_TRANSITIONS map + canTransition() + assertTransition()
│   │   │   └── errors.ts                   # AppError base class + domain error subclasses
│   │   │
│   │   ├── db/
│   │   │   ├── client.ts                   # pg.Pool creation + typed query helper
│   │   │   ├── migrate.ts                  # Migration runner (reads SQL files, tracks in _migrations table)
│   │   │   └── migrations/
│   │   │       └── 001_initial.sql
│   │   │
│   │   ├── repositories/                   # Data access — raw SQL, returns domain types
│   │   │   ├── raw-webhook.repository.ts   # insert(payload, headers) → RawWebhook
│   │   │   ├── contact.repository.ts       # upsertFromEvent(), findById(), findAll(), updateSyncStatus(), updateScore()
│   │   │   ├── sync-event.repository.ts    # insert(), findByContactId(), updateStatus(), existsByHubspotEventId()
│   │   │   └── user.repository.ts          # findByEmail(), findById()
│   │   │
│   │   ├── adapters/
│   │   │   ├── crm.interface.ts            # CrmAdapter interface + CrmEvent, CrmContact, WritebackResult types
│   │   │   ├── crm.factory.ts              # getCrmAdapter(config) → CrmAdapter
│   │   │   └── hubspot/
│   │   │       ├── adapter.ts              # HubSpotAdapter implements CrmAdapter
│   │   │       ├── mapper.ts               # toInternalContact(), toHubSpotProperties() — pure mapping functions
│   │   │       ├── signature.ts            # verifySignature(secret, requestBody, signatureHeader, url, method, timestamp)
│   │   │       └── types.ts                # HubSpot-specific payload types (webhook event shape, API response shape)
│   │   │
│   │   ├── services/
│   │   │   ├── auth.service.ts             # login(email, password) → { token, user }, verifyToken(token) → JwtPayload
│   │   │   ├── contact.service.ts          # upsertFromCrmEvent(), getContacts(), getContactById(), transitionStatus()
│   │   │   ├── sync.service.ts             # processEvent() — full orchestration: dedup → stale → upsert → enrich → writeback → log
│   │   │   ├── enrichment.service.ts       # enrich(contact) — simulated delay (3-15s) + score computation
│   │   │   └── ingestion.service.ts        # ingestWebhook() — persist raw → parse → enqueue jobs
│   │   │
│   │   ├── queue/
│   │   │   ├── connection.ts               # Shared IORedis instance (maxRetriesPerRequest: null for BullMQ)
│   │   │   ├── sync.queue.ts               # Queue definition + addSyncJob() producer function
│   │   │   └── sync.worker.ts              # Worker definition: job handler calls syncService.processEvent()
│   │   │
│   │   ├── routes/
│   │   │   ├── auth.routes.ts              # POST /api/auth/login — accepts { email, password }, returns { token, user }
│   │   │   ├── webhook.routes.ts           # POST /webhooks/hubspot — thin handler, delegates to ingestionService
│   │   │   ├── contact.routes.ts           # GET /api/contacts, GET /api/contacts/:id, GET /api/contacts/:id/history
│   │   │   └── sync.routes.ts              # POST /api/contacts/:id/resync, GET /api/stats
│   │   │
│   │   ├── middleware/
│   │   │   └── auth.middleware.ts           # Fastify onRequest hook: verify JWT, attach user to request, skip for /api/auth/*
│   │   │
│   │   └── utils/
│   │       ├── logger.ts                   # Pino logger instance (Fastify's built-in, re-exported for worker/services)
│   │       └── rate-limiter.ts             # Redis-backed sliding window: acquireToken(), releaseToken()
│   │
│   ├── scripts/
│   │   ├── hash-password.ts                # CLI: npx tsx scripts/hash-password.ts <password> → prints bcrypt hash
│   │   └── seed.ts                         # Seeds demo data: contacts in varied statuses + realistic sync history
│   │
│   └── tests/
│       ├── helpers/
│       │   ├── setup.ts                    # Test DB/Redis setup, teardown, seed helpers
│       │   └── fixtures.ts                 # Factory functions for test data (contacts, events, webhooks)
│       ├── unit/
│       │   ├── sync-status.test.ts         # State machine transitions
│       │   ├── mapper.test.ts              # HubSpot ↔ internal field mapping
│       │   └── enrichment.test.ts          # Score computation (not the delay)
│       └── integration/
│           ├── webhook.test.ts             # POST /webhooks/hubspot → DB + queue assertions
│           ├── idempotency.test.ts         # Same event twice → second skipped
│           └── stale-event.test.ts         # Older event after newer → skipped_stale
│
└── web/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    │
    └── src/
        ├── main.tsx                        # React root + QueryClientProvider + BrowserRouter
        ├── App.tsx                         # Route definitions
        │
        ├── types/                          # Shared API response types (mirrors server domain types)
        │   └── index.ts
        │
        ├── api/
        │   └── client.ts                   # fetch wrapper: getContacts(), getContact(), getHistory(), resync(), getStats()
        │
        ├── auth/
        │   ├── auth-context.tsx            # React context: { user, token, login(), logout() }
        │   ├── auth-provider.tsx           # Provider: manages token in localStorage, wraps app
        │   └── protected-route.tsx         # Redirects to /login if not authenticated
        │
        ├── hooks/
        │   ├── use-contacts.ts             # useQuery wrapper for contact list
        │   ├── use-contact.ts              # useQuery wrapper for single contact
        │   ├── use-sync-history.ts         # useQuery wrapper for sync history
        │   └── use-resync.ts              # useMutation wrapper for re-sync action
        │
        ├── pages/
        │   ├── LoginPage.tsx               # Email + password form → calls /api/auth/login → stores token → redirects
        │   ├── ContactListPage.tsx         # Table: name, email, status badge, score, last synced — click row → detail
        │   └── ContactDetailPage.tsx       # Contact summary card + sync history table + re-sync button
        │
        └── components/
            ├── Layout.tsx                  # Page shell: nav header, main content area
            ├── SyncStatusBadge.tsx         # Color-coded badge per status
            ├── SyncHistoryTable.tsx         # Table: direction, event type, status, timestamp, error
            ├── StatsBar.tsx                # Horizontal stats: total, synced, failed, processing counts
            └── ResyncButton.tsx            # Button with loading state + confirmation
```

---

## Implementation Phases

Each phase ends with a verifiable checkpoint — something you can run or test before proceeding.

---

### Phase 0 — Infrastructure Scaffolding
**Goal:** `docker-compose up` starts PostgreSQL + Redis; `npm run dev` starts an empty Fastify server that responds to health checks.

**Steps:**
1. Create `docker-compose.yml` (PostgreSQL 16 + Redis 7)
2. Initialize `server/package.json` with all dependencies
3. Create `server/tsconfig.json`
4. Create `server/src/config.ts` — Zod schema validates env vars, exports typed `Config`
5. Create `server/src/utils/logger.ts` — re-export pino instance
6. Create `server/src/index.ts` — minimal Fastify server with `GET /health` returning `{ status: "ok" }`
7. Add npm scripts: `dev` (tsx watch), `build` (tsc), `start` (node dist)

**Checkpoint:** `docker-compose up -d` → `npm run dev` → `curl localhost:3000/health` returns 200.

---

### Phase 1 — Database Layer
**Goal:** Migrations run on startup, tables exist (including `users` with seeded accounts), repositories can read/write.

**Steps:**
1. Create `server/src/db/client.ts` — `pg.Pool` from `Config.databaseUrl`, typed `query<T>()` helper
2. Create `server/src/db/migrate.ts` — reads `migrations/*.sql`, creates `_migrations` tracking table, runs pending migrations in order
3. Create `server/src/db/migrations/001_initial.sql` — full schema including `users` table (see SQL above)
4. Create `server/scripts/hash-password.ts` — small CLI utility to generate bcrypt hashes
5. Create `server/src/db/migrations/002_seed_users.sql` — seed operator accounts with pre-computed bcrypt hashes
6. Add `JWT_SECRET` to `config.ts` Zod schema (required env var)
7. Create `server/src/domain/types.ts` — all core TypeScript types/enums (including `User` type)
8. Create `server/src/domain/errors.ts` — `AppError`, `NotFoundError`, `DuplicateEventError`, `StaleEventError`, `UnauthorizedError`
9. Create `server/src/repositories/raw-webhook.repository.ts`
10. Create `server/src/repositories/contact.repository.ts`
11. Create `server/src/repositories/sync-event.repository.ts`
12. Create `server/src/repositories/user.repository.ts` — `findByEmail()`, `findById()`
13. Wire migration into `index.ts` — runs before server starts listening

**Checkpoint:** Server starts → logs "Migrations applied" → tables visible in PostgreSQL → `SELECT * FROM users` shows 2 seeded accounts.

---

### Phase 2 — Domain Logic (Pure, No I/O)
**Goal:** State machine, field mappers, and enrichment scoring are defined and unit-tested.

**Steps:**
1. Create `server/src/domain/sync-status.ts`:
   - `SyncStatus` enum
   - `ALLOWED_TRANSITIONS: Record<SyncStatus, SyncStatus[]>` map
   - `canTransition(from, to): boolean`
   - `getAllowedFromStatuses(to): SyncStatus[]`
2. Create `server/src/adapters/crm.interface.ts` — `CrmAdapter`, `CrmEvent`, `CrmContact`, `WritebackResult`
3. Create `server/src/adapters/hubspot/types.ts` — HubSpot webhook payload types, API response types
4. Create `server/src/adapters/hubspot/mapper.ts` — `toInternalContact()`, `toHubSpotProperties()`
5. Create `server/src/services/enrichment.service.ts` — `computeScore(contact): { score: number, status: string }` (deterministic), `enrich(contact): Promise<EnrichmentResult>` (adds delay)
6. Write unit tests:
   - `tests/unit/sync-status.test.ts` — all valid transitions pass, all invalid transitions blocked
   - `tests/unit/mapper.test.ts` — HubSpot event → internal contact mapping
   - `tests/unit/enrichment.test.ts` — score computation logic

**Checkpoint:** `npm test -- --run tests/unit` → all pass.

---

### Phase 3 — Queue Infrastructure
**Goal:** BullMQ queue and worker are wired up. Jobs can be enqueued and processed (stub handler).

**Steps:**
1. Create `server/src/queue/connection.ts` — shared `IORedis` instance with `maxRetriesPerRequest: null`
2. Create `server/src/queue/sync.queue.ts`:
   - `syncQueue` — BullMQ Queue instance with rate limiter config
   - `addSyncJob(eventId, contactId, rawWebhookId)` — producer function
3. Create `server/src/queue/sync.worker.ts`:
   - BullMQ Worker with concurrency config
   - Stub processor that logs "processing job" for now
   - Retry config: exponential backoff (5s, 15s, 45s, 135s, 405s), max 5 attempts
4. Wire queue + worker startup into `index.ts`
5. Create `server/src/utils/rate-limiter.ts` — Redis sliding window (for outbound API calls, separate from BullMQ queue limiter)

**Checkpoint:** Manually enqueue a test job via a temporary route → worker logs pick-up → job completes.

---

### Phase 4 — CRM Adapter (HubSpot)
**Goal:** Can validate webhook signatures, parse events, fetch a contact from HubSpot, and write back properties.

**Steps:**
1. Create `server/src/adapters/hubspot/signature.ts` — `verifySignatureV3(clientSecret, requestBody, signature, url, httpMethod, timestamp)`
2. Create `server/src/adapters/hubspot/adapter.ts` — `HubSpotAdapter implements CrmAdapter`:
   - `validateWebhook()` — calls signature verification
   - `parseEvents()` — extracts array of `CrmEvent` from HubSpot batch payload
   - `fetchContact(contactId)` — `GET /crm/v3/objects/contacts/{id}?properties=email,firstname,lastname`
   - `writebackScore(contactId, score, status)` — `PATCH /crm/v3/objects/contacts/{id}` with `lahzo_score`, `lahzo_status`
   - Uses rate limiter before each outbound call
   - Handles 429/5xx responses by throwing typed errors the worker can catch
3. Create `server/src/adapters/crm.factory.ts` — returns `HubSpotAdapter` (extensibility point)

**Checkpoint:** Write a small integration test or manual script that calls `fetchContact()` against the real HubSpot sandbox (requires a seeded contact). Verify write-back works.

---

### Phase 5 — Ingestion Pipeline (Webhook → DB → Queue)
**Goal:** `POST /webhooks/hubspot` persists the raw event and enqueues jobs.

**Steps:**
1. Create `server/src/services/ingestion.service.ts`:
   - `ingestWebhook(rawBody, headers)`:
     1. Validate signature via CRM adapter
     2. Insert raw payload into `raw_webhooks`
     3. Parse events via CRM adapter
     4. For each event: insert into `sync_events` (status: `received`) + enqueue BullMQ job
     5. Mark `raw_webhooks.processed = true`
   - Note: the contact may not exist yet at ingestion time. We create a minimal contact record on first event or defer to the worker. Decision: **create minimal contact record during ingestion** (just `hubspot_contact_id` + `sync_status: received` + `last_event_occurred_at`) so the FK in `sync_events` is satisfied. The worker then enriches it.
2. Create `server/src/routes/webhook.routes.ts`:
   - `POST /webhooks/hubspot` — get raw body, call `ingestionService.ingestWebhook()`, return 200
   - Must use `addContentTypeParser` for raw body access (Fastify parses JSON by default; we need the raw bytes for signature validation)

**Checkpoint:** `curl -X POST localhost:3000/webhooks/hubspot -H "Content-Type: application/json" -d '[...]'` → row appears in `raw_webhooks` and `sync_events`, job visible in Redis.

---

### Phase 6 — Processing Pipeline (Worker Logic)
**Goal:** Worker processes jobs end-to-end: dedup → stale check → upsert → enrich → writeback → log.

**Steps:**
1. Create `server/src/services/sync.service.ts` — `processEvent(syncEventId)`:
   1. Load `sync_event` from DB by ID
   2. **Idempotency check:** Redis `SET event:{hubspotEventId} NX EX 86400` — if exists, log skip + return
   3. Load associated contact
   4. **Stale check:** compare `event.occurred_at` with `contact.last_event_occurred_at` — if stale, update sync_event to `skipped_stale`, return
   5. **State machine check:** `canTransition(contact.sync_status, 'processing')` — if blocked, re-queue with delay or skip
   6. Transition contact to `processing` (with timestamp guard in WHERE clause)
   7. Update sync_event to `processing`
   8. Fetch full contact data from CRM via adapter
   9. Update internal contact fields from CRM data
   10. Call `enrichmentService.enrich()` (3-15s delay + score)
   11. Update contact: `lahzo_score`, `lahzo_status`
   12. Call `adapter.writebackScore()` — push to HubSpot
   13. Log outbound sync_event (direction: `outbound`, type: `api_writeback`)
   14. Transition contact to `synced`
   15. Update sync_event to `synced` with `processed_at`
   - **Error handling:** catch → transition contact to `failed` + log error_message → throw (BullMQ retries)
2. Wire `syncService.processEvent()` into `sync.worker.ts` job handler
3. Write idempotency integration test
4. Write stale event integration test

**Checkpoint:** Manually POST a webhook → worker processes it → contact appears with `sync_status: synced` → `lahzo_score` written back to HubSpot. Run integration tests — pass.

---

### Phase 7 — Auth + Operator API Routes
**Goal:** Login works, all API endpoints are JWT-protected, seed script populates demo data.

**Steps:**
1. Create `server/src/services/auth.service.ts`:
   - `login(email, password)` — find user by email, compare bcrypt hash, sign JWT (8h expiry), return `{ token, user }`
   - `verifyToken(token)` — verify JWT, return payload `{ userId, email }`
2. Create `server/src/middleware/auth.middleware.ts`:
   - Fastify `onRequest` hook registered on `/api/*` routes
   - Skips `/api/auth/login`
   - Reads `Authorization: Bearer <token>` header
   - Calls `authService.verifyToken()` → attaches user to `request.user`
   - Returns 401 if missing/invalid
3. Create `server/src/routes/auth.routes.ts`:
   - `POST /api/auth/login` — validates `{ email, password }` with Zod, delegates to `authService.login()`
   - Response: `{ token: string, user: { id, email, name } }`
4. Create `server/src/routes/contact.routes.ts`:
   - `GET /api/contacts` — paginated list, query params: `page`, `limit`, `status` (optional filter)
     - Response: `{ data: Contact[], total: number, page: number, limit: number }`
   - `GET /api/contacts/:id` — single contact with summary stats (event count, last synced)
   - `GET /api/contacts/:id/history` — all sync_events for this contact, ordered by `created_at DESC`
     - Response: `{ data: SyncEvent[] }`
5. Create `server/src/routes/sync.routes.ts`:
   - `POST /api/contacts/:id/resync` — enqueue a new sync job for existing contact, transition to `processing`
     - Response: `{ message: "Re-sync queued", jobId: string }`
   - `GET /api/stats` — aggregate counts by sync_status + recent failures
     - Response: `{ total: number, byStatus: Record<SyncStatus, number>, recentFailures: SyncEvent[] }`
6. Register all routes in `index.ts` (auth middleware applied before contact/sync routes)
7. Add `@fastify/cors` with `origin: 'http://localhost:5173'` (Vite dev server)
8. Create `server/scripts/seed.ts` — populates demo data for reviewer:
   - 8–10 contacts in varied sync statuses (`synced`, `failed`, `processing`, `skipped_stale`)
   - Each contact has 2–5 sync_events (mix of `inbound` and `outbound`, realistic timestamps)
   - Contacts have varied `lahzo_score` values and some with `last_error` messages
   - Run via `npx tsx scripts/seed.ts`

**Checkpoint:** `curl -X POST localhost:3000/api/auth/login -d '{"email":"admin@lahzo.dev","password":"admin123"}'` returns token. Using that token: `curl -H "Authorization: Bearer <token>" localhost:3000/api/contacts` returns seeded data. Without token → 401.

---

### Phase 8 — Frontend
**Goal:** Operator UI with contact list, detail view, sync history, and re-sync button.

**Steps:**
1. Initialize `web/` — `npm create vite@latest` with React + TypeScript template
2. Install dependencies: `react-router-dom`, `@tanstack/react-query`, `tailwindcss`, `@tailwindcss/vite`
3. Configure `vite.config.ts` with API proxy to `http://localhost:3000` (avoids CORS in dev)
4. Create `web/src/types/index.ts` — mirror server types for API responses
5. Create `web/src/api/client.ts`:
   - All fetch calls include `Authorization: Bearer <token>` header from auth context
   - `login(email, password)` → `POST /api/auth/login`
   - `getContacts(page, limit, status?)` → `GET /api/contacts`
   - `getContact(id)` → `GET /api/contacts/:id`
   - `getSyncHistory(id)` → `GET /api/contacts/:id/history`
   - `resyncContact(id)` → `POST /api/contacts/:id/resync`
   - `getStats()` → `GET /api/stats`
   - On 401 response → clear stored token, redirect to `/login`
6. Create `web/src/auth/auth-context.tsx` — React context: `{ user, token, login(), logout(), isAuthenticated }`
7. Create `web/src/auth/auth-provider.tsx` — manages token in localStorage, exposes context
8. Create `web/src/auth/protected-route.tsx` — wrapper that redirects to `/login` if `!isAuthenticated`
9. Create `pages/LoginPage.tsx`:
   - Centered card with email + password fields
   - Submit calls `login()` from auth context
   - On success → redirect to `/`
   - On error → show "Invalid credentials" message
10. Create hooks: `use-contacts.ts`, `use-contact.ts`, `use-sync-history.ts`, `use-resync.ts`
11. Create `components/Layout.tsx` — page shell with header ("Lahzo Sync Dashboard"), user email display, logout button
12. Create `components/SyncStatusBadge.tsx` — colored pill per status
13. Create `components/StatsBar.tsx` — horizontal stat cards
14. Create `pages/ContactListPage.tsx`:
    - Stats bar at top
    - Filter dropdown by sync_status
    - Table: name, email, status badge, score, last synced at
    - Click row → navigate to `/contacts/:id`
    - Pagination controls
15. Create `pages/ContactDetailPage.tsx`:
    - Back link
    - Contact summary card (name, email, score, status, last error)
    - Re-sync button (with loading/success state)
    - Sync history table (direction icon, event type, status, timestamp, error if any)
16. Create `components/ResyncButton.tsx` — button with mutation state
17. Create `components/SyncHistoryTable.tsx` — table with direction + type + status + time + error
18. Wire routes in `App.tsx`:
    - `/login` → LoginPage (public)
    - `/` → ProtectedRoute → ContactListPage
    - `/contacts/:id` → ProtectedRoute → ContactDetailPage
19. Set up `main.tsx` with `AuthProvider` + `QueryClientProvider` + `BrowserRouter`

**Checkpoint:** `npm run dev` in web/ → redirected to login → enter `admin@lahzo.dev` / `admin123` → redirected to contact list → works as before. Logout → back to login.

---

### Phase 9 — Integration Testing
**Goal:** Core spec requirements verified with automated tests.

**Steps:**
1. Create `tests/helpers/setup.ts`:
   - Spin up test PostgreSQL + Redis (use docker or connect to docker-compose services on alternate ports)
   - Run migrations
   - Export `getTestDb()`, `getTestRedis()`, `cleanup()` utilities
2. Create `tests/helpers/fixtures.ts`:
   - `buildHubSpotWebhookPayload(overrides?)` — generates realistic HubSpot event batch
   - `buildContact(overrides?)`, `buildSyncEvent(overrides?)`
3. `tests/integration/idempotency.test.ts`:
   - Send same webhook event twice
   - Assert only one `sync_event` with `synced` status
   - Assert second call was skipped (no new sync_event, or status `skipped`)
4. `tests/integration/stale-event.test.ts`:
   - Process newer event first (occurredAt: T+10)
   - Then process older event (occurredAt: T+0)
   - Assert older event is `skipped_stale`
   - Assert contact data still reflects newer event
5. `tests/integration/webhook.test.ts`:
   - POST to `/webhooks/hubspot` with valid payload
   - Assert `raw_webhooks` row created
   - Assert `sync_events` row created with status `received`
   - Assert BullMQ job enqueued

**Checkpoint:** `npm test` → all tests green.

---

### Phase 10 — Docker, Docs, Polish
**Goal:** Everything runnable via `docker-compose up`, README complete.

**Steps:**
1. Add `Dockerfile` for server (multi-stage: build → production)
2. Add `Dockerfile` for web (build → nginx serve)
3. Update `docker-compose.yml` to include server + web services
4. Update `README.md`:
   - CRM choice and why
   - Prerequisites (Docker, ngrok account)
   - Quick start: `docker-compose up` → configure HubSpot webhook URL → done
   - Environment variables reference
   - Architecture overview (link to ARCHITECTURE.md)
   - How to run tests
5. Add startup reconciliation: on server boot, query `raw_webhooks WHERE processed = false` and re-enqueue
6. Optional: Salesforce adapter sketch (`adapters/salesforce/adapter.ts`) — implement interface with placeholder methods + comments explaining what each would do

**Checkpoint:** Fresh clone → `cp .env.example .env` → fill credentials → `docker-compose up` → working system.

---

## Build Order Summary

| Phase | What | Output | Depends on |
|---|---|---|---|
| **0** | Scaffolding + Docker | Running server + DB + Redis | Nothing |
| **1** | Database layer | Migrations + repositories | Phase 0 |
| **2** | Domain logic + unit tests | State machine, mapper, enrichment tested | Phase 1 (types only) |
| **3** | Queue infrastructure | BullMQ queue + worker (stub) | Phase 0 |
| **4** | HubSpot adapter | CRM API client | Phase 2 |
| **5** | Ingestion pipeline | Webhook → DB → queue | Phase 1, 3, 4 |
| **6** | Processing pipeline | Worker end-to-end | Phase 1, 2, 3, 4, 5 |
| **7** | Auth + Operator API + Seed data | JWT auth, REST endpoints, demo data | Phase 1, 6 |
| **8** | Frontend | React SPA | Phase 7 |
| **9** | Integration tests | Automated test suite | Phase 6 |
| **10** | Docker + docs + polish | Submission-ready | All |
