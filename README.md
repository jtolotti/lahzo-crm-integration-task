# Lahzo — CRM Integration Service

A production-grade integration service that syncs contacts between a SaaS platform and HubSpot CRM. Built as a technical assessment for Senior Client Integration Engineer.

## CRM Choice

**HubSpot (Option A)** — free developer account, native webhook subscriptions, real-world constraints (rate limits, short timeout, eventual delivery) with no simulation needed. See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed rationale.

## Architecture

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
                     │    (skip if already processed)
                     │  2. Stale?   │
                     │    (skip if older event exists)
                     │  3. Fetch    │
                     │    (GET contact from HubSpot)
                     │  4. Enrich   │
                     │    (simulate external scoring API)
                     │  5. Score    │     ┌─────────────┐
                     │    (compute lahzo_score)  │
                     │  6. Writeback│────▶│  HubSpot    │
                     │    (PATCH score + status) │  CRM API    │
                     │              │     └─────────────┘
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

- **Accept-and-queue**: Webhook handler persists raw event + enqueues job in <100ms, returns 200 within HubSpot's ~5s timeout
- **Async processing**: BullMQ worker handles enrichment (3–15s), scoring, and CRM writeback with OAuth tokens (auto-refreshed)
- **Durability**: Raw webhooks persisted to PostgreSQL before acknowledging — no events lost
- **Idempotency**: Three-layer dedup (ingestion query + PostgreSQL UNIQUE constraint + worker status check)
- **Stale protection**: Timestamp-based optimistic concurrency + state machine transitions
- **Rate limiting**: Redis sliding-window limiter (80 req/10s) + BullMQ queue-level limiter
- **OAuth**: Single Legacy App with proactive token refresh — zero expired-token failures

Full design details: [ARCHITECTURE.md](./ARCHITECTURE.md)

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (Node.js) |
| HTTP Framework | Fastify |
| Database | PostgreSQL 16 |
| Queue | BullMQ (Redis 7) |
| Frontend | React + Vite + TailwindCSS |
| Auth | JWT (bcrypt password hashing) |

## Prerequisites

- **Node.js** v18+ (tested on v24.15.0)
- **Docker Desktop** (for PostgreSQL + Redis)
- **ngrok** (to expose local webhook endpoint to HubSpot)
- **HubSpot** developer account with a test portal

## Quick Start

### 1. Clone and configure

```bash
git clone <repo-url>
cd lahzo
cp .env.example .env
# Edit .env — see Environment Variables section for all required values
# (HubSpot credentials, JWT secret, ngrok token, database/Redis URLs)
```

### 2. Start infrastructure

```bash
docker-compose up -d
```

This starts PostgreSQL (port 5432) and Redis (port 6379).

### 3. Install dependencies and start server

```bash
cd server
npm install
npm run dev
```

The server runs migrations automatically on startup, including seeding operator accounts.

### 4. Authorize HubSpot (one-time OAuth)

Open your browser and visit:

```
http://localhost:3000/hubspot/auth
```

This redirects to HubSpot's OAuth page. Authorize the app with your test account. You'll be redirected back with a success message. Tokens are stored locally in `.hubspot-tokens.json` (gitignored) and refresh automatically.

### 5. Seed demo data (optional)

```bash
cd server
npx tsx scripts/seed.ts
```

Populates contacts in varied sync statuses (`synced`, `failed`, `processing`, etc.) with realistic sync history, so the dashboard has data to explore immediately.

### 6. Start the frontend

```bash
cd client
npm install
npm run dev
```

Frontend available at `http://localhost:5173` (proxies API calls to the backend).

### 7. Expose webhook endpoint (for live HubSpot events)

```bash
ngrok http 3000
```

Copy the HTTPS URL and configure it as your HubSpot webhook target:
`https://<your-ngrok-url>/webhooks/hubspot`

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `HUBSPOT_CLIENT_ID` | Legacy app client ID (OAuth + webhook setup) | `xxxx-xxxx-xxxx` |
| `HUBSPOT_CLIENT_SECRET` | Legacy app client secret (OAuth + signature verification) | `xxxx-xxxx-xxxx` |
| `HUBSPOT_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/hubspot/auth/callback` |
| `HUBSPOT_PORTAL_ID` | HubSpot portal/account ID | `12345678` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://lahzo:lahzo@localhost:5432/lahzo` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_SECRET` | Secret for signing JWT tokens | (any strong random string) |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `NGROK_AUTHTOKEN` | ngrok auth token (for persistent tunnel URLs) | `xxxx` |

## Operator Dashboard

Login at `http://localhost:5173` with seeded credentials:

| Email | Password | Role |
|---|---|---|
| `admin@lahzo.dev` | `admin123` | **Admin** |
| `reviewer@lahzo.dev` | `reviewer123` | Operator |

> **No external credentials needed.** Both accounts are created automatically by the migration at `server/src/db/migrations/002_seed_users.sql` — the file contains the plaintext passwords in comments alongside the bcrypt hashes, so you can read the login emails and passwords directly from there. Migration `003_add_user_roles.sql` then promotes the admin account to the `admin` role.
>
> **Note:** Plaintext passwords in migration comments exist solely for reviewer convenience during this assessment. In a production environment, seeded credentials would never be committed to source control — accounts would be provisioned via SSO/SAML or a secure onboarding flow.

Features (all roles):
- **Dashboard** — contact list with status filter cards, pagination
- **Contact detail** — full sync history (inbound + outbound events), timestamps, error messages
- **Re-sync** — retry failed events or re-trigger sync for any contact
- **Auth guard** — all routes JWT-protected

### Beyond Requirements

The following features were **not part of the core task requirements** but were implemented as production-oriented decisions. Each is justified below.

#### Optional items (from task spec)

- **Docker + docker-compose** — `docker-compose up -d` starts PostgreSQL and Redis with health checks, persistent volumes, and correct networking. `--profile full` adds the server and frontend containers. Ensures zero "works on my machine" issues for the reviewer.
- **Automated idempotency test** — 3 integration tests verify duplicate webhook re-delivery is handled correctly (first accepted, second skipped, single sync event in DB). 45 unit tests cover the state machine, scoring, signature verification, and field mapping.
- **Salesforce adapter sketch** — `server/src/adapters/salesforce/adapter.ts` implements the `CrmAdapter` interface with detailed production notes (CDC vs Apex callouts, `__c` custom fields, OAuth JWT Bearer flow). Demonstrates that the core pipeline requires zero changes to support a second CRM.
- **Structured logging** — pino (Fastify's built-in logger) with JSON output, log levels per environment, and contextual fields on every log line (`syncEventId`, `contactId`, `eventType`). Production-ready for log aggregation (ELK, Datadog).

#### Additional production decisions

- **Role-Based Access Control (RBAC)** — Any real integration platform needs visibility tiers. Operators see contact status and trigger re-syncs; admins inspect raw webhook payloads for debugging. Two roles (`admin`, `operator`) enforced at both backend (`requireAdmin` middleware) and frontend (conditional UI rendering). Admin-only features: webhooks log page, payload viewer on sync events, 403 enforcement.
- **Global error handler** — Unhandled errors return structured JSON (`{ error, detail }`) instead of raw stack traces. In production mode, `detail` is omitted to prevent information leakage. Without this, a single unhandled throw exposes internal paths and dependency versions.
- **Input validation** — Query parameters (`page`, `limit`) are clamped to safe ranges (1–100) with fallback defaults. Prevents NaN propagation and unreasonable queries without adding a validation library.
- **Graceful shutdown** — On `SIGINT`/`SIGTERM`, the server closes the BullMQ worker (finishes in-flight jobs), the Fastify HTTP server (drains connections), the PostgreSQL pool, and the Redis connection. Prevents orphaned connections and data corruption during deploys.
- **Zod-validated configuration** — Environment variables are validated at startup with Zod schemas. Missing or malformed config fails fast with a clear error message instead of crashing mid-request on an undefined value.

## API Endpoints

### Webhook (signature-protected)
| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/hubspot` | Receives HubSpot webhook batches |

### Auth (public)
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Login with email/password, returns JWT |

### Operator API (JWT-protected)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/contacts` | List contacts (paginated, filterable by status) |
| `GET` | `/api/contacts/:id` | Contact detail + sync events |
| `GET` | `/api/contacts/stats/summary` | Status counts |
| `POST` | `/api/contacts/:id/resync` | Re-trigger full sync for a contact |
| `GET` | `/api/sync-events/failures` | Recent failed events |
| `POST` | `/api/sync-events/:id/retry` | Re-queue a failed event |

### Admin API (JWT + admin role required)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/webhooks` | Paginated raw webhook log |
| `GET` | `/api/admin/webhooks/:id` | Full webhook payload + headers |
| `GET` | `/api/admin/sync-events/:id/payload` | Sync event payload inspection |

## Testing

### Unit tests (45 tests)

```bash
cd server
npx vitest run tests/unit
```

Covers: state machine transitions (24), enrichment scoring (9), webhook signature verification (7), HubSpot field mapping (5).

### Integration tests (3 tests)

```bash
cd server
npx vitest run tests/integration
```

Covers: idempotent webhook re-delivery — verifies that a duplicate webhook payload is accepted once, skipped on re-delivery, and produces exactly one sync event.

### E2E test (against live HubSpot)

```bash
cd server
npx tsx scripts/test-e2e-webhook.ts
```

This fetches a real contact from HubSpot, sends a signed webhook, waits for worker processing, and verifies both the local database state and HubSpot writeback.

### Seed demo data

```bash
cd server
npx tsx scripts/seed.ts
```

Populates contacts in varied sync statuses with realistic sync history for UI review.

## HubSpot Setup

1. Create a **developer account** at [developers.hubspot.com](https://developers.hubspot.com)
2. Create a **test account** inside the developer portal
3. Create a **Legacy App** in the developer account:
   - Under **Auth**, add scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.write`
   - Set **Redirect URL** to: `http://localhost:3000/hubspot/auth/callback`
   - Copy the **client ID** → `HUBSPOT_CLIENT_ID` in `.env`
   - Copy the **client secret** → `HUBSPOT_CLIENT_SECRET` in `.env`
4. Start the server (`npm run dev`) and visit `http://localhost:3000/hubspot/auth` to authorize
5. Create custom properties (automated):
   ```bash
   cd server
   npx tsx scripts/setup-hubspot-properties.ts
   ```

### Exposing local server with ngrok

The task requires exposing the local webhook endpoint to HubSpot using ngrok (or equivalent).

```bash
# Terminal 1 — start the server
cd server && npm run dev

# Terminal 2 — start ngrok tunnel
ngrok http 3000
```

ngrok will output a public URL like `https://a1b2c3d4.ngrok-free.app`.

### Configuring HubSpot webhook subscriptions

1. Go to your HubSpot developer account → **Apps** → your Legacy App → **Webhooks**
2. Set **Target URL** to: `https://<your-ngrok-url>/webhooks/hubspot`
3. Create subscriptions:
   - `contact.creation`
   - `contact.propertyChange`
4. **Activate** the subscriptions

### Live test

1. Open your HubSpot test account CRM → **Contacts** → **Create contact**
2. Fill in name and email, save
3. Within seconds, you should see:
   - Server logs showing the webhook received and processed
   - The contact appear on the operator dashboard at `http://localhost:5173`
   - `lahzo_score` and `lahzo_status` written back to the contact in HubSpot
4. Edit the contact's properties in HubSpot → a `contact.propertyChange` event fires → re-processed by the pipeline

> **Note:** ngrok free tier generates a new URL on each restart. Update the Target URL in HubSpot accordingly. For persistent URLs, use `ngrok http 3000 --domain=your-subdomain.ngrok-free.app` (requires free ngrok account).

## Project Structure

```
lahzo/
├── ARCHITECTURE.md          # System design document
├── README.md                # This file
├── docker-compose.yml       # PostgreSQL + Redis
├── .env.example             # Environment template
├── server/
│   ├── src/
│   │   ├── index.ts         # Fastify server bootstrap
│   │   ├── config.ts        # Zod-validated config
│   │   ├── domain/          # Pure types, state machine, errors
│   │   ├── db/              # PostgreSQL client + migrations
│   │   ├── repositories/    # Data access (raw SQL)
│   │   ├── adapters/        # CRM adapter interface + HubSpot implementation
│   │   ├── services/        # Business logic (ingestion, sync, enrichment, auth)
│   │   ├── queue/           # BullMQ queue + worker
│   │   ├── routes/          # HTTP route handlers
│   │   ├── middleware/      # JWT auth guard
│   │   └── utils/           # Logger, rate limiter
│   ├── scripts/             # Test + seed scripts
│   └── tests/               # Unit + integration tests
└── client/
    └── src/
        ├── App.tsx           # Route definitions
        ├── context/          # Auth context
        ├── lib/              # API client
        ├── pages/            # Login, Dashboard, Contact Detail, Webhooks (admin)
        └── components/       # Layout, shared components
```
