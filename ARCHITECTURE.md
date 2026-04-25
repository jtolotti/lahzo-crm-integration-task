# Architecture & Design Document

## 1. CRM Choice: HubSpot (Option A)

**Why HubSpot:**

- Free developer account with a sandbox CRM — no trial expiry, no credit card, zero friction to get started.
- Native webhook subscriptions for `contact.creation` and `contact.propertyChange` — the exact events we need, delivered by HubSpot's infrastructure rather than us polling.
- CRM v3 REST API is well-documented and straightforward for reading/updating contacts with custom properties.
- Real-world constraints (short webhook timeout, rate limits, eventual delivery) come for free — no simulation needed.

---

## 2. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| **Language** | TypeScript (Node.js) | First-class async I/O model ideal for webhook handlers and outbound API calls. Shared types between backend and frontend reduce mapping bugs — critical in an integration service. |
| **HTTP Framework** | Fastify | Built-in JSON schema validation on routes (catches malformed payloads at the edge), significantly faster than Express, excellent TypeScript support, and a clean plugin architecture for organizing CRM adapters. |
| **Database** | PostgreSQL | ACID transactions guarantee that persisting a raw event and enqueuing a job happen atomically (no lost events). Relational integrity for contacts ↔ sync events. JSONB columns give us schema-flexible storage for raw CRM payloads without giving up queryability. |
| **Queue** | BullMQ (Redis-backed) | Production-grade job queue for Node.js. Built-in retry with configurable exponential backoff, native rate limiting per queue, delayed jobs, dead-letter queue, and job lifecycle events — all requirements from the spec, out of the box. |
| **Cache / Rate Limiter** | Redis | Already required by BullMQ. We reuse it for fast idempotency checks (SET NX on event IDs) and as a sliding-window token bucket for outbound HubSpot API rate limiting. One dependency serving three roles. |
| **Frontend** | React + Vite | Lightweight SPA. Vite gives instant HMR during development. React lets us compose the contact list → detail → sync history views cleanly. TailwindCSS for minimal but structured styling without a component library overhead. |
| **Tunneling** | ngrok | Exposes the local webhook endpoint over HTTPS so HubSpot can deliver events during development. |
| **Containerization** | Docker + docker-compose | Single `docker-compose up` brings up PostgreSQL, Redis, the backend server, and the frontend — reproducible environment, no "works on my machine". |

**Why not Python/FastAPI?** Both are excellent. TypeScript was chosen because: (a) sharing types between the webhook payload validation, internal models, and the frontend API reduces a class of integration bugs that is central to this assessment; (b) BullMQ is more feature-complete than Celery/RQ for the specific queue semantics required (per-job rate limiting, stale job detection, native backoff curves).

---

## 3. System Architecture

```
┌─────────────┐       webhook (HTTPS via ngrok)
│  HubSpot    │─────────────────────────────────────────┐
│  CRM        │                                         │
└─────────────┘                                         ▼
                                              ┌───────────────────┐
                                              │  Fastify Server    │
                                              │  /webhooks/hubspot │
                                              │                    │
                                              │  1. Validate sig   │
                                              │  2. Persist raw    │
                                              │     event (PG)     │
                                              │  3. Enqueue job    │
                                              │     (BullMQ)       │
                                              │  4. Return 200     │
                                              └────────┬──────────┘
                                                       │
                              ┌─────────────────────────┤
                              ▼                         ▼
                     ┌──────────────┐          ┌──────────────────┐
                     │   Redis      │          │   PostgreSQL     │
                     │  (BullMQ     │          │                  │
                     │   queues +   │          │  contacts        │
                     │   idempot.   │          │  sync_events     │
                     │   cache)     │          │  raw_webhooks    │
                     └──────┬───────┘          └──────────────────┘
                            │                          ▲
                            ▼                          │
                     ┌──────────────┐                  │
                     │  Sync Worker │                  │
                     │              │                  │
                     │  1. Dedup    │──── writes ──────┘
                     │  2. Stale?   │
                     │  3. Upsert   │
                     │  4. Enrich   │     ┌─────────────┐
                     │     (3-15s)  │     │  HubSpot    │
                     │  5. Score    │────▶│  CRM API    │
                     │  6. Writeback│     │  PATCH      │
                     │  7. Log      │     └─────────────┘
                     └──────────────┘
                            │
                            ▼
                     ┌──────────────────┐
                     │  Operator UI     │
                     │  (React SPA)     │
                     │                  │
                     │  GET /api/contacts│
                     │  GET /api/contacts/:id/history│
                     │  POST /api/contacts/:id/resync│
                     └──────────────────┘
```

### Request lifecycle (happy path)

1. HubSpot fires a webhook batch (array of events) to our `/webhooks/hubspot` endpoint.
2. The handler validates the `X-HubSpot-Signature-v3` header against our client secret.
3. Each event in the batch is inserted into `raw_webhooks` (PostgreSQL) and a job is enqueued to BullMQ — both inside a single database transaction where possible (event persistence is the source of truth; the queue is the delivery mechanism).
4. The handler returns `200 OK` immediately — well within HubSpot's ~5s timeout.
5. The **Sync Worker** picks up the job from the queue.
6. It checks idempotency: has this `eventId` already been processed? (fast lookup in Redis, backed by a UNIQUE constraint in `sync_events`).
7. It checks staleness: is the event's `occurredAt` older than the contact's `last_event_occurred_at`? If yes → mark `skipped_stale`, done.
8. It upserts the contact in the internal `contacts` table.
9. It runs simulated enrichment (3–15s delay + trivial score computation).
10. It writes back `lahzo_score` and `lahzo_status` to HubSpot via `PATCH /crm/v3/objects/contacts/{contactId}`.
11. It logs the outbound call in `sync_events` (direction: `outbound`, status, response, timestamp).
12. It updates the contact's `sync_status` to `synced`.

---

## 4. Handling the Short Webhook Timeout

**Problem:** HubSpot expects a 2xx response within ~5 seconds. Processing takes 3–15 seconds. If we process synchronously, we will timeout and HubSpot will retry — creating duplicates and wasting resources.

**Solution: Accept-and-queue.** The webhook handler does only three things:
1. Validate the request signature.
2. Persist the raw event to PostgreSQL (guarantees durability).
3. Enqueue a job ID reference to BullMQ.

All three operations complete in < 100ms. The handler then returns `200`. Processing happens entirely in the worker, outside the HTTP request lifecycle.

**Why this works:** The webhook handler is a thin ingestion gateway. It never does business logic. This gives us deterministic, fast response times regardless of processing load.

---

## 5. Decoupling Ingestion from Processing

The webhook handler and the sync worker are logically separate components connected only through the BullMQ queue (backed by Redis).

**Benefits:**
- **Independent scaling:** We can run multiple worker instances if throughput demands it, without changing the webhook handler.
- **Backpressure handling:** If workers are slow, jobs accumulate in the queue rather than causing HTTP timeouts.
- **Failure isolation:** A worker crash doesn't affect event ingestion. Events are already persisted in PostgreSQL and queued in Redis.
- **Testability:** Workers can be tested independently by pushing synthetic jobs to the queue.

**Queue configuration:**
- **Concurrency:** Workers process N jobs in parallel (configurable; default ~5 to stay within HubSpot rate limits).
- **Rate limiting:** BullMQ's built-in `limiter` option: `{ max: 80, duration: 10000 }` — keeps us safely under HubSpot's 100 req/10s ceiling with headroom.
- **Retry:** Failed jobs retry with exponential backoff: delays of 5s, 15s, 45s, 135s (up to 5 attempts).
- **Dead-letter:** After max retries, jobs move to a DLQ for operator review.

---

## 6. Idempotency (Duplicate Prevention)

**Problem:** HubSpot may deliver the same event multiple times (network retries, our timeout, their internal retries).

**Strategy — two layers:**

1. **Fast path (Redis):** Before processing, the worker does `SET eventId NX EX 86400` in Redis. If the key already exists, the event is a duplicate → skip immediately. This is O(1) and avoids hitting the database for repeated deliveries.

2. **Durable path (PostgreSQL):** The `sync_events` table has a `UNIQUE` constraint on `(hubspot_event_id)`. Even if Redis is flushed, re-processing the same event will fail the insert and be caught gracefully.

**Why two layers:** Redis gives us speed for the hot path (HubSpot often retries within seconds). PostgreSQL gives us correctness even after Redis restarts or evictions.

---

## 7. Out-of-Order Event Handling (Stale Update Protection)

**Problem:** HubSpot does not guarantee event ordering. An older `propertyChange` event may arrive after a newer one. Applying it would overwrite newer data. Additionally, a new inbound event should not regress a contact's `sync_status` if it's already in a more advanced processing stage.

**Two complementary protections:**

### 7a. Timestamp-based optimistic concurrency (data protection)

Each contact record stores `last_event_occurred_at` (the `occurredAt` timestamp from the most recently applied HubSpot event).

When the worker processes an event:
```sql
UPDATE contacts
SET    ..., last_event_occurred_at = $occurredAt, sync_status = 'processing'
WHERE  hubspot_contact_id = $contactId
AND    last_event_occurred_at < $occurredAt
```

If `rowCount === 0`, the event is stale → mark it `skipped_stale` in `sync_events`, do not proceed with enrichment or writeback.

**Why this works:** The `WHERE` clause acts as an atomic compare-and-swap. No race conditions even with concurrent workers processing events for the same contact. The database is the single source of truth for ordering.

**Edge case — first event:** When a contact doesn't exist yet (`contact.creation`), we `INSERT` with the event's `occurredAt`. Subsequent events must have a newer timestamp to update.

### 7b. State machine (status regression protection)

The timestamp check prevents stale **data**, but we also need to prevent stale **status transitions**. Consider: a contact is mid-enrichment (`processing`) and a new event with a newer timestamp arrives — it should not reset the status back to `received`.

We enforce a directed state machine where `sync_status` can only move forward through allowed transitions:

```
             ┌──────────────────────────────┐
             ▼                              │ (new event with newer timestamp
         received ──▶ processing ──▶ synced   triggers a fresh cycle)
             │            │
             ▼            ▼
       skipped_stale    failed ──▶ (retry) ──▶ processing
```

**Allowed transitions:**

| From | To | Trigger |
|---|---|---|
| `received` | `processing` | Worker picks up the job |
| `processing` | `synced` | Enrichment + writeback succeed |
| `processing` | `failed` | Enrichment or writeback error |
| `failed` | `processing` | Retry (automatic or manual re-sync) |
| `synced` | `processing` | New event with newer timestamp arrives (new cycle) |
| `received` | `skipped_stale` | Event is older than `last_event_occurred_at` |
| `processing` | `skipped_stale` | Not allowed — never regress an active job |

**Implementation:** The status update query enforces allowed transitions:

```sql
UPDATE contacts
SET    sync_status = $newStatus, updated_at = NOW()
WHERE  hubspot_contact_id = $contactId
AND    sync_status = ANY($allowedFromStatuses)
```

The worker checks `rowCount` — if 0, the transition was invalid and the event is handled accordingly (logged, not applied).

**Why both layers:** The timestamp check answers "is this event's **data** newer?" The state machine answers "is this **transition** valid given the contact's current processing stage?" Together they prevent both data regression and status regression.

---

## 8. Event Durability (No Event Loss)

**Guarantee:** Once the webhook handler returns `200`, the event will eventually be processed — even if the worker crashes, Redis restarts, or HubSpot's API is down for hours.

**How:**

1. **Persist before acknowledge.** The raw event is written to `raw_webhooks` (PostgreSQL) before the 200 response. PostgreSQL is our durable source of truth.
2. **Queue is a delivery mechanism, not storage.** If Redis loses data, we can replay unprocessed events from `raw_webhooks` (events where no corresponding `sync_events` entry with a terminal status exists).
3. **Worker failures trigger retries.** BullMQ automatically retries failed jobs with exponential backoff. The job payload contains the event ID, and the worker re-reads the full event from PostgreSQL.
4. **Dead-letter queue.** After exhausting retries, the job lands in a DLQ. The operator UI surfaces these for manual review and re-trigger.

**Recovery procedure:** A startup reconciliation query can detect "stuck" events (persisted but never processed) and re-enqueue them. This handles Redis data loss or deployment gaps.

---

## 9. CRM API Rate Limiting & Transient Failure Handling

**HubSpot limits:** 100–150 requests per 10 seconds per app (depending on tier).

**Strategy — layered rate limiting:**

1. **Queue-level rate limit:** BullMQ's `limiter` restricts job processing throughput globally. Set to ~80 req/10s to leave headroom for manual API calls and operator UI reads.
2. **Outbound HTTP client rate limiter:** A sliding-window token bucket in Redis wraps the HubSpot API client. Before each API call, acquire a token. If none available, delay the job (BullMQ supports delayed re-queue).
3. **429 response handling:** If HubSpot returns `429 Too Many Requests`, respect the `Retry-After` header. Re-queue the job with the specified delay.
4. **5xx response handling:** Transient server errors trigger exponential backoff retry (same as job-level retry). The sync event is logged with status `failed` and the error message.

**Why two layers:** The queue limiter prevents bursts. The HTTP client limiter handles the case where a single job makes multiple API calls (e.g., read then write). Together they keep us well within HubSpot's ceiling.

---

## 10. Schema Mapping

### CRM Adapter Interface

We define a `CrmAdapter` interface that abstracts CRM-specific logic:

```typescript
interface CrmAdapter {
  validateWebhook(request: RawRequest): Promise<boolean>;
  parseEvents(payload: unknown): CrmEvent[];
  fetchContact(contactId: string): Promise<CrmContact>;
  writebackScore(contactId: string, score: number, status: string): Promise<WritebackResult>;
}
```

The **HubSpot adapter** implements this interface, translating between HubSpot's field names and our internal model.

### Field Mapping

| HubSpot Property | Internal Field | Notes |
|---|---|---|
| `objectId` | `hubspot_contact_id` | HubSpot's internal contact ID |
| `firstname` | `first_name` | Standard property |
| `lastname` | `last_name` | Standard property |
| `email` | `email` | Standard property |
| `lahzo_score` | `lahzo_score` | Custom property — created in HubSpot |
| `lahzo_status` | `lahzo_status` | Custom property — created in HubSpot |

**Raw payload preserved:** We always store the complete raw HubSpot payload in `sync_events.payload` (JSONB). This means we can re-map fields retroactively if our internal model evolves, and we have a full audit trail for debugging integration issues.

**Why an adapter interface:** Adding Salesforce (or any other CRM) means implementing the same 4 methods with Salesforce field names and API calls. The worker, queue, database, and UI remain untouched. This is explicitly called out in the optional requirements and demonstrates the abstraction.

---

## 11. Data Model

### `contacts`
| Column | Type | Purpose |
|---|---|---|
| `id` | UUID (PK) | Internal identifier |
| `hubspot_contact_id` | VARCHAR (UNIQUE) | CRM-side identifier |
| `email` | VARCHAR | Mapped from CRM |
| `first_name` | VARCHAR | Mapped from CRM |
| `last_name` | VARCHAR | Mapped from CRM |
| `lahzo_score` | INTEGER | Computed score |
| `lahzo_status` | VARCHAR | Computed status |
| `sync_status` | ENUM(`received`, `processing`, `synced`, `failed`, `skipped_stale`) | Current state |
| `last_error` | TEXT | Last failure message (nullable) |
| `last_event_occurred_at` | TIMESTAMPTZ | HubSpot event timestamp — used for stale detection |
| `created_at` | TIMESTAMPTZ | Record creation |
| `updated_at` | TIMESTAMPTZ | Last modification |

### `sync_events`
| Column | Type | Purpose |
|---|---|---|
| `id` | UUID (PK) | Internal identifier |
| `contact_id` | UUID (FK → contacts) | Which contact this event relates to |
| `hubspot_event_id` | VARCHAR (UNIQUE, nullable) | Idempotency key for inbound events |
| `direction` | ENUM(`inbound`, `outbound`) | Webhook receipt vs. API writeback |
| `event_type` | VARCHAR | `contact.creation`, `contact.propertyChange`, `api_writeback` |
| `payload` | JSONB | Full raw payload (inbound) or request/response (outbound) |
| `status` | ENUM(`received`, `processing`, `synced`, `failed`, `skipped_stale`) | Outcome |
| `error_message` | TEXT | Error details on failure (nullable) |
| `occurred_at` | TIMESTAMPTZ | When the event happened in the CRM |
| `processed_at` | TIMESTAMPTZ | When our worker finished processing |
| `created_at` | TIMESTAMPTZ | Record creation |

### `raw_webhooks`
| Column | Type | Purpose |
|---|---|---|
| `id` | UUID (PK) | Internal identifier |
| `payload` | JSONB | Complete raw webhook request body |
| `headers` | JSONB | Request headers (for signature verification replay) |
| `received_at` | TIMESTAMPTZ | When we received the webhook |
| `processed` | BOOLEAN (default false) | Whether all events in this batch have been enqueued |

### `users`
| Column | Type | Purpose |
|---|---|---|
| `id` | UUID (PK) | Internal identifier |
| `email` | VARCHAR (UNIQUE) | Login identifier |
| `password_hash` | VARCHAR | bcrypt-hashed password |
| `name` | VARCHAR | Display name |
| `created_at` | TIMESTAMPTZ | Record creation |

Minimal table — just enough for operator authentication. Seeded with 1–2 accounts at migration time. Passwords stored as bcrypt hashes (never plaintext). In production this would be replaced by SSO/SAML, but having real auth demonstrates the security boundary.

**Why four tables:**
- `raw_webhooks` is our crash-recovery safety net — the immutable record of what HubSpot sent us.
- `contacts` is the internal materialized view of CRM data — what the operator UI queries.
- `sync_events` is the full audit trail — every inbound event and every outbound API call, with timestamps and outcomes. This is what the "sync history" view displays.
- `users` is the operator identity store — keeps the dashboard behind a login wall.

### Indexes
- `contacts(hubspot_contact_id)` — unique, for fast upsert lookups.
- `contacts(sync_status)` — for operator UI filtering (e.g., "show all failed").
- `sync_events(contact_id, created_at)` — for fetching a contact's history in chronological order.
- `sync_events(hubspot_event_id)` — unique, for idempotency enforcement.
- `raw_webhooks(processed, received_at)` — for the recovery reconciliation query.

---

## 12. API Design

### Webhook Endpoint (unauthenticated — secured by signature validation)
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/webhooks/hubspot` | Receives HubSpot webhook batches |

### Auth API (unauthenticated)
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Accepts `{ email, password }`, returns `{ token, user }` |

### Operator API (JWT-protected — consumed by the frontend)
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/contacts` | List contacts with current sync status (paginated) |
| `GET` | `/api/contacts/:id` | Get a single contact with summary |
| `GET` | `/api/contacts/:id/history` | Full sync history for a contact (inbound + outbound events) |
| `POST` | `/api/contacts/:id/resync` | Manually re-trigger sync for a contact |
| `GET` | `/api/stats` | Dashboard stats: total contacts, by sync status, recent failures |

### Authentication approach

- **JWT tokens** — stateless, no server-side session store needed. The token is short-lived (8h) and contains `{ userId, email }`. The frontend sends it as `Authorization: Bearer <token>`.
- **bcrypt** for password hashing — industry standard, 12 salt rounds.
- **Fastify `onRequest` hook** on `/api/*` routes (excluding `/api/auth/login`) verifies the JWT and attaches the user to the request context.
- **Seeded accounts** — the migration seeds 1–2 operator accounts so the reviewer can log in immediately. Credentials documented in README.

---

## 13. Tradeoffs

| Decision | Tradeoff | Why we accept it |
|---|---|---|
| **PostgreSQL for raw event storage** | Slightly higher write latency than an append-only log (Kafka). | For single-client scale, PG is more than sufficient and eliminates an extra infrastructure dependency. The raw_webhooks table is append-only in practice. |
| **Redis for both queue and cache** | Single point of failure for job delivery. | Mitigated by PostgreSQL being the durable source of truth. Redis loss means temporary processing delays, not data loss. The reconciliation query re-enqueues missed events. |
| **Single worker process** | Can't horizontally scale processing independently. | For this assessment's scale, a single worker with configurable concurrency is sufficient. The architecture supports multiple workers trivially (BullMQ handles distributed locking). |
| **Optimistic timestamp check (not vector clocks)** | If two events have the exact same `occurredAt`, the first one to process wins. | HubSpot timestamps are millisecond-precision. Exact collisions are extremely rare, and in that case either event is equally valid. |
| **JWT auth (no refresh tokens)** | Token expires after 8h; user must re-login. | Good enough for an operator dashboard. Production would add refresh token rotation or SSO. |
| **Fastify over Express** | Smaller ecosystem, less community familiarity. | The built-in schema validation, better performance, and cleaner TypeScript DX outweigh ecosystem size for this use case. |

---

## 14. Production Scale Considerations

What would change for **multiple clients, multiple CRMs** at production scale:

1. **Multi-tenancy:** Add a `tenant_id` column to all tables. Each tenant has its own CRM credentials, adapter configuration, and webhook URL. Queue jobs are tagged with `tenant_id` for isolated processing.

2. **CRM adapter registry:** The `CrmAdapter` interface already supports this. A factory function selects the right adapter based on the tenant's configured CRM type. Adding a new CRM is a new adapter implementation — no changes to the core pipeline.

3. **Dedicated queues per tenant:** Prevents a high-volume tenant from starving others. BullMQ supports named queues trivially.

4. **Horizontal scaling:** Multiple worker instances behind a load balancer for the webhook endpoint. BullMQ handles distributed job processing natively. PostgreSQL read replicas for the operator UI queries.

5. **Kafka or equivalent:** At scale, replace Redis/BullMQ with Kafka for event streaming — gives us partitioned, ordered, replayable event logs. Worth the complexity only when throughput demands it.

6. **Observability:** Structured logging (pino), distributed tracing (OpenTelemetry), metrics (Prometheus) — sync lag, failure rate, queue depth, API response times. Alerting on DLQ growth.

7. **Credential management:** Move CRM API keys and secrets to a vault (AWS Secrets Manager, HashiCorp Vault) rather than environment variables.

8. **Schema registry:** Formalize field mappings per tenant/CRM in a configuration store rather than code, allowing non-engineering teams to adjust mappings.

---

## 15. Testing Strategy

| Level | What we test | Approach |
|---|---|---|
| **Unit** | Schema mapping, score computation, stale detection logic, idempotency checks | Pure functions, no I/O. Fast, no dependencies. |
| **Integration** | Webhook handler → DB persistence → queue enqueue; Worker → DB update → CRM API call | Testcontainers for PostgreSQL and Redis. Mock HubSpot API with `nock` or `msw`. |
| **Idempotency regression** | Same webhook event delivered twice → only one sync_event with status `synced`, second is skipped | Core spec requirement — explicit test case. |
| **Stale event regression** | Older event processed after newer one → marked `skipped_stale` | Explicit test case. |
| **Rate limit handling** | Simulated 429 response → job retried with backoff | Mock HubSpot API returning 429, assert retry count and delay. |
| **E2E (if time allows)** | Create contact in HubSpot sandbox → verify sync_event appears in operator UI | Manual or Playwright against the running stack. |

---

## 16. Project Structure

```
lahzo/
├── ARCHITECTURE.md
├── README.md
├── docker-compose.yml
├── .env.example
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                  # Entry point — Fastify server bootstrap
│   │   ├── config.ts                 # Env-based configuration
│   │   ├── db/
│   │   │   ├── client.ts             # PostgreSQL connection (pg or Kysely)
│   │   │   └── migrations/
│   │   │       └── 001_initial.sql   # Schema creation
│   │   ├── adapters/
│   │   │   ├── crm.interface.ts      # CrmAdapter interface
│   │   │   └── hubspot/
│   │   │       ├── adapter.ts        # HubSpot CrmAdapter implementation
│   │   │       ├── mapper.ts         # Field mapping HubSpot ↔ internal
│   │   │       └── signature.ts      # Webhook signature validation
│   │   ├── queue/
│   │   │   ├── connection.ts         # Redis/BullMQ connection
│   │   │   ├── sync.queue.ts         # Queue definition + producers
│   │   │   └── sync.worker.ts        # Worker: dedup → stale check → enrich → writeback
│   │   ├── services/
│   │   │   ├── contact.service.ts    # Contact CRUD + sync status management
│   │   │   ├── sync.service.ts       # Sync orchestration logic
│   │   │   └── enrichment.service.ts # Simulated enrichment + scoring
│   │   ├── routes/
│   │   │   ├── webhook.routes.ts     # POST /webhooks/hubspot
│   │   │   ├── contact.routes.ts     # GET /api/contacts, GET /api/contacts/:id
│   │   │   └── sync.routes.ts        # POST /api/contacts/:id/resync
│   │   └── utils/
│   │       ├── logger.ts             # Structured logger (pino)
│   │       └── rate-limiter.ts       # Sliding window rate limiter
│   └── tests/
│       ├── unit/
│       └── integration/
└── web/
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── App.tsx
        ├── main.tsx
        ├── api/                      # API client
        ├── pages/
        │   ├── ContactList.tsx
        │   └── ContactDetail.tsx
        └── components/
            ├── SyncStatusBadge.tsx
            └── SyncHistoryTable.tsx
```

---

## 17. Sequence Diagram — Full Sync Lifecycle

```
HubSpot           Webhook Handler        PostgreSQL       Redis/BullMQ       Sync Worker         HubSpot API
   │                    │                    │                 │                  │                   │
   │── POST /webhooks ─▶│                    │                 │                  │                   │
   │                    │── validate sig ───▶│                 │                  │                   │
   │                    │── INSERT raw ─────▶│                 │                  │                   │
   │                    │── enqueue job ────────────────────▶│                  │                   │
   │◀── 200 OK ────────│                    │                 │                  │                   │
   │                    │                    │                 │── pick up job ──▶│                   │
   │                    │                    │                 │                  │── SET NX (dedup) ▶│
   │                    │                    │                 │                  │                   │
   │                    │                    │◀── check stale ─│                  │                   │
   │                    │                    │── upsert ──────▶│                  │                   │
   │                    │                    │                 │                  │── enrich (3-15s) ─│
   │                    │                    │                 │                  │── compute score ──│
   │                    │                    │                 │                  │── PATCH contact ─▶│
   │                    │                    │                 │                  │◀── 200 OK ────────│
   │                    │                    │◀── log outbound │                  │                   │
   │                    │                    │◀── status=synced│                  │                   │
```
