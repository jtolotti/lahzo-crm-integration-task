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
| **Cache / Rate Limiter** | Redis | Already required by BullMQ. We reuse it as a sliding-window token bucket for outbound HubSpot API rate limiting. One dependency serving two roles (queue + rate limiter). |
| **Frontend** | React + Vite | Lightweight SPA. Vite gives instant HMR during development. React lets us compose the contact list → detail → sync history views cleanly. TailwindCSS for minimal but structured styling without a component library overhead. |
| **Tunneling** | ngrok | Exposes the local webhook endpoint over HTTPS so HubSpot can deliver events during development. |
| **Containerization** | Docker + docker-compose | `docker-compose up -d` starts PostgreSQL and Redis; `docker-compose --profile full up -d` adds the backend server and frontend — reproducible environment, no "works on my machine". |

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
                     │   rate       │          │  sync_events     │
                     │   limiter)   │          │  raw_webhooks    │
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
                     │  GET /api/contacts/:id│
                     │  POST /api/contacts/:id/resync│
                     └──────────────────┘
```

### Request lifecycle (happy path)

1. HubSpot fires a webhook batch (array of events) to our `/webhooks/hubspot` endpoint.
2. The handler validates the `X-HubSpot-Signature` header (v2 HMAC-SHA256) against our client secret.
3. Each event in the batch is inserted into `raw_webhooks` (PostgreSQL) and a job is enqueued to BullMQ — both inside a single database transaction where possible (event persistence is the source of truth; the queue is the delivery mechanism).
4. The handler returns `200 OK` immediately — well within HubSpot's ~5s timeout.
5. The **Sync Worker** picks up the job from the queue.
6. It checks idempotency: has this `eventId` already been processed? (status check — if already `synced` or `skipped_stale`, skip immediately).
7. It checks staleness: is the event's `occurredAt` older than the contact's `last_event_occurred_at`? If yes → mark `skipped_stale`, done.
8. It upserts the contact in the internal `contacts` table.
9. It runs simulated enrichment (3–15s delay + trivial score computation).
10. It writes back `lahzo_score` and `lahzo_status` to HubSpot via `PATCH /crm/v3/objects/contacts/{contactId}`.
11. It logs the outbound call in `sync_events` (direction: `outbound`, status, response, timestamp).
12. It updates the contact's `sync_status` to `synced`.

### Event processing flow (with edge cases)

```
HubSpot webhook POST
         │
         ▼
┌─────────────────────┐
│ Signature valid?     │──── NO ──▶ 401 Unauthorized
└─────────┬───────────┘
          │ YES
          ▼
┌─────────────────────┐
│ Persist raw webhook  │──▶ raw_webhooks table (durability guarantee)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ For each event:      │
│ Duplicate eventId?   │──── YES ─▶ Skip (count as duplicate)
└─────────┬───────────┘
          │ NO
          ▼
┌─────────────────────┐
│ Upsert contact       │──▶ contacts table (status: received)
│ Insert sync_event    │──▶ sync_events table (UNIQUE constraint = 2nd dedup layer)
│ Enqueue BullMQ job   │
└─────────┬───────────┘
          │
          ▼
  Return 200 OK (<100ms)
          ·
          · (async — worker picks up job)
          ·
          ▼
┌─────────────────────┐
│ Already processed?   │──── YES ─▶ Skip (synced/skipped_stale = 3rd dedup layer)
│ (status check)       │
└─────────┬───────────┘
          │ NO
          ▼
┌─────────────────────┐
│ State transition     │──── INVALID ─▶ InvalidTransitionError (e.g. synced→received)
│ allowed?             │
└─────────┬───────────┘
          │ VALID
          ▼
  Contact status → processing
          │
          ▼
┌─────────────────────┐
│ Stale event?         │──── YES ─▶ Mark skipped_stale, done
│ occurredAt < contact │
│ .last_event_at       │
└─────────┬───────────┘
          │ NO (fresh)
          ▼
┌─────────────────────┐
│ Fetch contact from   │──── 429 ─▶ RateLimitError → BullMQ retries with backoff
│ HubSpot CRM API     │──── 5xx ─▶ TransientCrmError → BullMQ retries with backoff
└─────────┬───────────┘──── 4xx ─▶ Mark failed, log error
          │ 200 OK
          ▼
┌─────────────────────┐
│ Enrich + Score       │  (3–15s simulated delay)
│ computeScore()       │  deterministic: email, name, domain, properties
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Rate limiter check   │──── WAIT ─▶ Sliding window pause until token available
│ (Redis sorted set)   │
└─────────┬───────────┘
          │ TOKEN
          ▼
┌─────────────────────┐
│ Writeback to HubSpot │──── 429 ─▶ RateLimitError → BullMQ retries
│ PATCH lahzo_score    │──── 5xx ─▶ TransientCrmError → BullMQ retries
│ PATCH lahzo_status   │
└─────────┬───────────┘
          │ 200 OK
          ▼
┌─────────────────────┐
│ Log outbound event   │──▶ sync_events (direction: outbound, type: score.writeback)
│ Update contact       │──▶ contacts (sync_status: synced, lahzo_score, lahzo_status)
└─────────────────────┘
          │
          ▼
        DONE ✓
```

> **Manual re-sync** follows the same worker path starting from the "Already processed?" check, with `event_type: manual.resync`. **Retry** resets a failed event's status to `received` and re-enqueues it, re-entering at the same point.

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
- **Retry:** Failed jobs retry with exponential backoff: delays of 5s, 10s, 20s, 40s, 80s (up to 5 attempts).
- **Dead-letter:** After max retries, jobs move to a DLQ for operator review.

---

## 6. Idempotency (Duplicate Prevention)

**Problem:** HubSpot may deliver the same event multiple times (network retries, our timeout, their internal retries).

**Strategy — three layers:**

1. **Ingestion-time check:** During webhook ingestion (before enqueuing), we query `sync_events` for an existing `hubspot_event_id`. If found, the event is a known duplicate → skip immediately, never enqueued.

2. **Database constraint (safety net):** The `sync_events` table has a `UNIQUE` constraint on `(hubspot_event_id)`. Even if the application-level check has a race condition (two concurrent webhook deliveries), the database constraint catches it.

3. **Worker-level idempotency:** The worker checks `sync_event.status` before processing. If the event is already `synced` or `skipped_stale`, it returns immediately — safe against BullMQ job retries.

**Why multiple layers:** The ingestion check prevents unnecessary queue work. The UNIQUE constraint guarantees correctness at the database level. The worker status check handles BullMQ retry scenarios. Together they cover all duplicate delivery paths.

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

### 7c. Edge Case Scenario Matrix

| Scenario | Detection Point | Path Taken | Final Status |
|---|---|---|---|
| **Duplicate delivery** (same `eventId` sent twice) | Ingestion — `existsByHubspotEventId()` returns true | Second delivery skipped entirely, never enqueued | First event proceeds normally |
| **Stale event** (older `occurredAt` arrives after newer) | Worker — `occurred_at < last_event_occurred_at` | Marked `skipped_stale`, no enrichment or writeback | `skipped_stale` (terminal) |
| **CRM rate limit** (HubSpot returns 429) | Worker — `throwCrmError()` detects 429 | `RateLimitError` thrown → BullMQ retries with exponential backoff | Retries up to 5× then `failed` |
| **CRM transient error** (HubSpot returns 5xx) | Worker — `throwCrmError()` detects 5xx | `TransientCrmError` thrown → same retry path | Retries up to 5× then `failed` |
| **CRM permanent error** (HubSpot returns 4xx) | Worker — generic error thrown | Job fails, contact marked `failed` with error message | `failed` (operator can retry) |
| **Invalid webhook signature** | Webhook handler — `validateWebhook()` returns false | 401 returned, payload never persisted or enqueued | Rejected at the edge |
| **Redis down during ingestion** | `addSyncJob()` fails | Event already persisted in `raw_webhooks` + `sync_events` — recoverable via reconciliation | `received` (stuck until re-enqueued) |
| **Worker crash mid-processing** | BullMQ detects stalled job | Job automatically retried by BullMQ; worker re-reads from PostgreSQL | Retries from `processing` |
| **Manual re-sync** (operator clicks button) | `POST /contacts/:id/resync` | New `sync_event` created (no `hubspot_event_id`), enqueued, full pipeline runs | `synced` or `failed` |
| **Retry failed event** | `POST /sync-events/:id/retry` | Status reset to `received`, re-enqueued, worker retries | `synced` or `failed` |

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
  validateWebhook(request: FastifyRequest): boolean;
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
| `event_type` | VARCHAR | `contact.creation`, `contact.propertyChange`, `score.writeback`, `manual.resync` |
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
| `role` | ENUM(`admin`, `operator`) | RBAC role (default: `operator`) |
| `created_at` | TIMESTAMPTZ | Record creation |

Minimal table — just enough for operator authentication and role-based access control. Seeded with an admin and operator account at migration time. Passwords stored as bcrypt hashes (never plaintext). In production this would be replaced by SSO/SAML, but having real auth + RBAC demonstrates the security boundary.

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

### Operator API (JWT-protected)
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/contacts` | List contacts (paginated, filterable by sync status) |
| `GET` | `/api/contacts/:id` | Contact detail + full sync event history |
| `GET` | `/api/contacts/stats/summary` | Status counts for dashboard cards |
| `POST` | `/api/contacts/:id/resync` | Re-trigger full sync for a contact |
| `GET` | `/api/sync-events/failures` | Recent failed sync events |
| `POST` | `/api/sync-events/:id/retry` | Re-queue a failed sync event |

### Admin API (JWT + admin role required)
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/webhooks` | Paginated raw webhook log |
| `GET` | `/api/admin/webhooks/:id` | Full webhook payload + headers |
| `GET` | `/api/admin/sync-events/:id/payload` | Sync event payload inspection |

### Authentication & RBAC

- **JWT tokens** — stateless, short-lived (8h), containing `{ userId, email, name, role }`. The frontend sends it as `Authorization: Bearer <token>`.
- **bcrypt** for password hashing — industry standard, 12 salt rounds.
- **Two middleware layers:** `requireAuth` (verifies JWT, attaches user) and `requireAdmin` (checks `role === 'admin'`).
- **Two roles:** `admin` (full access including raw webhook inspection) and `operator` (contact management and sync operations).
- **Seeded accounts** — migrations seed an admin and an operator account so the reviewer can log in immediately. Credentials documented in README.

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

## 14. Beyond Requirements

The following features go beyond the core task specification. Each was a deliberate decision to demonstrate production thinking.

### Optional items (from task spec)

| Feature | Implementation | Rationale |
|---|---|---|
| **Docker + docker-compose** | `docker-compose.yml` with PostgreSQL 16 + Redis 7, health checks, persistent volumes. `--profile full` adds server + frontend containers. | Reviewer can start infrastructure with a single command. Eliminates environment inconsistencies. |
| **Automated tests (48 total)** | 45 unit tests (state machine, scoring, signature, mapping) + 3 integration tests (idempotent re-delivery). | The idempotency test is explicitly called out in the spec as a minimum. Unit tests cover every pure function in the domain layer. |
| **Salesforce adapter sketch** | `server/src/adapters/salesforce/adapter.ts` — full `CrmAdapter` implementation with production notes on CDC, `__c` fields, OAuth JWT Bearer flow, and daily API limits. | Proves the adapter pattern works: the core pipeline (ingestion → queue → worker → sync events → UI) requires zero changes to support a second CRM. |
| **Structured logging** | pino (via Fastify) with JSON output, environment-based log levels, contextual fields (`syncEventId`, `contactId`, `eventType`) on every log line. | Production-ready for log aggregation (ELK, Datadog). Enables debugging sync issues across the entire pipeline without adding print statements. |

### Additional production decisions

| Feature | Implementation | Rationale |
|---|---|---|
| **RBAC (admin/operator)** | `user_role` enum, `requireAdmin` middleware, role in JWT payload, conditional UI rendering, 403 enforcement. | Any real integration platform needs visibility tiers — operators manage contacts, admins debug raw payloads. Demonstrates security-in-depth beyond basic auth. |
| **Global error handler** | Fastify `setErrorHandler` returns structured JSON; hides `detail` in production mode. | Without this, an unhandled throw exposes stack traces, internal paths, and dependency versions to the caller. |
| **Input validation** | `page`/`limit` query params clamped to safe ranges (1–100) with fallback defaults. | Prevents NaN propagation from malformed input and unreasonable queries without adding a validation library. |
| **Graceful shutdown** | On SIGINT/SIGTERM: close BullMQ worker → Fastify server → PostgreSQL pool → Redis connection. | Prevents orphaned connections, in-flight job corruption, and connection pool exhaustion during deploys. |
| **Zod-validated config** | All environment variables validated at startup via Zod schemas. | Fail-fast with clear error messages instead of crashing mid-request on an undefined value. Catches misconfiguration before the server accepts traffic. |

---

## 15. Production Scale Considerations

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

## 16. Testing Strategy

| Level | What we test | Approach |
|---|---|---|
| **Unit (45 tests)** | State machine transitions (24), enrichment scoring (9), signature verification (7), HubSpot field mapping (5) | Pure functions, no I/O. Fast, no dependencies. `npx vitest run tests/unit` |
| **Integration (3 tests)** | Idempotent re-delivery: same webhook sent twice → first accepted, second skipped, only one sync_event exists | Runs against live server + PostgreSQL + Redis (`npm run dev` must be running). `npx vitest run tests/integration` |
| **E2E script** | Create real contact in HubSpot → send signed webhook → verify local DB state and HubSpot writeback | `npx tsx scripts/test-e2e-webhook.ts` — requires live HubSpot credentials and running server |

---

## 17. Project Structure

```
lahzo/
├── ARCHITECTURE.md                        # This document
├── README.md                              # Quick start, env vars, API reference
├── docker-compose.yml                     # PostgreSQL + Redis
├── .env.example                           # Environment variable template
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                       # Fastify bootstrap, route registration, shutdown
│   │   ├── config.ts                      # Zod-validated env configuration
│   │   ├── domain/
│   │   │   ├── types.ts                   # SyncStatus, EventDirection, UserRole, interfaces
│   │   │   ├── sync-status.ts             # State machine (transitions + validation)
│   │   │   └── errors.ts                  # Typed error classes (NotFound, DuplicateEvent, etc.)
│   │   ├── db/
│   │   │   ├── client.ts                  # PostgreSQL pool (pg)
│   │   │   ├── migrate.ts                 # Migration runner
│   │   │   └── migrations/
│   │   │       ├── 001_initial.sql         # Schema: contacts, sync_events, raw_webhooks, users
│   │   │       ├── 002_seed_users.sql      # Seed admin + operator accounts
│   │   │       └── 003_add_user_roles.sql  # RBAC: user_role enum + role column
│   │   ├── repositories/
│   │   │   ├── contact.repository.ts       # Contact CRUD (upsert, find, update score/status)
│   │   │   ├── sync-event.repository.ts    # Sync event persistence + dedup queries
│   │   │   ├── raw-webhook.repository.ts   # Raw webhook storage + admin listing
│   │   │   └── user.repository.ts          # User lookup for auth
│   │   ├── adapters/
│   │   │   ├── crm.interface.ts            # CrmAdapter interface
│   │   │   ├── crm.factory.ts             # Adapter singleton factory
│   │   │   ├── hubspot/
│   │   │   │   ├── adapter.ts              # HubSpot CrmAdapter implementation
│   │   │   │   ├── mapper.ts              # Field mapping HubSpot ↔ internal
│   │   │   │   ├── signature.ts           # Webhook signature verification (v2 used, v3 available)
│   │   │   │   └── types.ts               # HubSpot-specific type definitions
│   │   │   └── salesforce/
│   │   │       └── adapter.ts             # Salesforce adapter stub (extensibility demo)
│   │   ├── queue/
│   │   │   ├── connection.ts              # Shared Redis connection for BullMQ
│   │   │   ├── sync.queue.ts              # Queue definition + job producer
│   │   │   └── sync.worker.ts             # Worker: picks jobs, delegates to sync.service
│   │   ├── services/
│   │   │   ├── ingestion.service.ts        # Webhook ingestion (persist → parse → enqueue)
│   │   │   ├── sync.service.ts            # 11-step processing pipeline
│   │   │   ├── enrichment.service.ts      # Simulated enrichment (3-15s delay + scoring)
│   │   │   ├── contact.service.ts         # Contact business logic + state transitions
│   │   │   └── auth.service.ts            # Login + JWT signing
│   │   ├── routes/
│   │   │   ├── webhook.routes.ts           # POST /webhooks/hubspot
│   │   │   ├── auth.routes.ts             # POST /api/auth/login
│   │   │   ├── contact.routes.ts          # /api/contacts (list, detail, stats, resync)
│   │   │   ├── sync-event.routes.ts       # /api/sync-events (failures, retry)
│   │   │   └── admin.routes.ts            # /api/admin/* (raw webhooks, payload inspect)
│   │   ├── middleware/
│   │   │   └── auth.middleware.ts          # requireAuth + requireAdmin hooks
│   │   └── utils/
│   │       ├── logger.ts                  # Structured logger (pino)
│   │       └── rate-limiter.ts            # Sliding-window token bucket (Redis)
│   ├── scripts/
│   │   ├── seed.ts                        # Seed demo contacts with varied sync statuses
│   │   ├── hash-password.ts               # Utility: generate bcrypt hash for user passwords
│   │   ├── setup-hubspot-properties.ts    # Create lahzo_score + lahzo_status in HubSpot
│   │   ├── test-webhook.ts                # Send a signed test webhook
│   │   ├── test-e2e-webhook.ts            # E2E: create contact in HubSpot → verify pipeline
│   │   └── test-live-webhook.ts           # Test against a live HubSpot contact
│   └── tests/
│       ├── unit/
│       │   ├── enrichment.test.ts          # Scoring logic (9 tests)
│       │   ├── signature.test.ts          # Signature verification (7 tests)
│       │   ├── mapper.test.ts             # Field mapping (5 tests)
│       │   └── sync-status.test.ts        # State machine transitions (24 tests)
│       └── integration/
│           └── idempotency.test.ts        # Duplicate webhook re-delivery (3 tests)
└── client/
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── App.tsx                        # Router setup (React Router)
        ├── main.tsx                       # Entry point
        ├── index.css                      # TailwindCSS imports
        ├── lib/
        │   └── api.ts                     # Typed API client + interfaces
        ├── context/
        │   └── auth.tsx                   # Auth context (JWT + role management)
        ├── components/
        │   └── Layout.tsx                 # Shared layout with nav + role-aware menu
        └── pages/
            ├── LoginPage.tsx              # Login form
            ├── DashboardPage.tsx          # Contact list + status filter cards + pagination
            ├── ContactDetailPage.tsx      # Contact detail + sync event timeline + resync
            └── WebhooksPage.tsx           # Raw webhook log (admin only)
```

---

## 18. Sequence Diagram — Full Sync Lifecycle

```
HubSpot           Webhook Handler        PostgreSQL       Redis/BullMQ       Sync Worker         HubSpot API
   │                    │                    │                 │                  │                   │
   │── POST /webhooks ─▶│                    │                 │                  │                   │
   │                    │── validate sig ───▶│                 │                  │                   │
   │                    │── INSERT raw ─────▶│                 │                  │                   │
   │                    │── enqueue job ────────────────────▶│                  │                   │
   │◀── 200 OK ────────│                    │                 │                  │                   │
   │                    │                    │                 │── pick up job ──▶│                   │
   │                    │                    │                 │                  │── status check ──▶│
   │                    │                    │                 │                  │   (idempotency)   │
   │                    │                    │◀── check stale ─│                  │                   │
   │                    │                    │── upsert ──────▶│                  │                   │
   │                    │                    │                 │                  │── enrich (3-15s) ─│
   │                    │                    │                 │                  │── compute score ──│
   │                    │                    │                 │                  │── PATCH contact ─▶│
   │                    │                    │                 │                  │◀── 200 OK ────────│
   │                    │                    │◀── log outbound │                  │                   │
   │                    │                    │◀── status=synced│                  │                   │
```
