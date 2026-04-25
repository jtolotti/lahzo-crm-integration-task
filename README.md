# Lahzo — CRM Integration Service

A production-grade integration service that syncs contacts between a SaaS platform and HubSpot CRM. Built as a technical assessment for Senior Client Integration Engineer.

## CRM Choice

**HubSpot (Option A)** — free developer account, native webhook subscriptions, real-world constraints (rate limits, short timeout, eventual delivery) with no simulation needed. See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed rationale.

## Architecture

```
HubSpot CRM ──webhook──▶ Fastify Server ──persist──▶ PostgreSQL
                              │                         ▲
                              └──enqueue──▶ BullMQ ─────┘
                                          (Redis)    │
                                              ▼      │
                                         Sync Worker ──writeback──▶ HubSpot API
                                              │
                                              ▼
                                         Operator UI (React)
```

- **Accept-and-queue**: Webhook handler persists raw event + enqueues job in <100ms, returns 200 within HubSpot's ~5s timeout
- **Async processing**: BullMQ worker handles enrichment (3–15s), scoring, and CRM writeback
- **Durability**: Raw webhooks persisted to PostgreSQL before acknowledging — no events lost
- **Idempotency**: Two-layer dedup (PostgreSQL UNIQUE + sync event status check)
- **Stale protection**: Timestamp-based optimistic concurrency + state machine transitions
- **Rate limiting**: Redis sliding-window limiter (80 req/10s) + BullMQ queue-level limiter

Full design details: [ARCHITECTURE.md](./ARCHITECTURE.md) | Build order: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

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
# Edit .env with your HubSpot credentials
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

### 4. Start the frontend

```bash
cd client
npm install
npm run dev
```

Frontend available at `http://localhost:5173` (proxies API calls to the backend).

### 5. Expose webhook endpoint (for live HubSpot events)

```bash
ngrok http 3000
```

Copy the HTTPS URL and configure it as your HubSpot webhook target:
`https://<your-ngrok-url>/webhooks/hubspot`

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Private app access token | `pat-na1-xxxx` |
| `HUBSPOT_CLIENT_SECRET` | Private app client secret (for signature verification) | `xxxx-xxxx-xxxx` |
| `HUBSPOT_PORTAL_ID` | HubSpot portal/account ID | `51387961` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://lahzo:lahzo@localhost:5432/lahzo` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_SECRET` | Secret for signing JWT tokens | (any strong random string) |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `development` |

## Operator Dashboard

Login at `http://localhost:5173` with seeded credentials:

| Email | Password | Role |
|---|---|---|
| `admin@lahzo.dev` | `admin123` | **Admin** |
| `reviewer@lahzo.dev` | `reviewer123` | Operator |

Features (all roles):
- **Dashboard** — contact list with status filter cards, pagination
- **Contact detail** — full sync history (inbound + outbound events), timestamps, error messages
- **Re-sync** — retry failed events or re-trigger sync for any contact
- **Auth guard** — all routes JWT-protected

### Role-Based Access Control (beyond requirements)

RBAC was not part of the original task requirements. I implemented it as a production-oriented bonus because any real integration platform needs visibility tiers — operators should see contact status, while admins need raw payload inspection for debugging webhook issues.

**Admin-only features:**
- **Webhooks Log** — dedicated page listing every raw webhook received, with expandable payload + headers inspection
- **Payload viewer** — on the contact detail page, admins can expand any sync event to see its full JSON payload
- **403 enforcement** — admin endpoints return `403 Forbidden` for operator-role users, both backend and frontend guarded

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

Covers: state machine transitions, HubSpot field mapping, enrichment scoring, webhook signature verification.

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
3. Create a **private app** (Legacy) with scopes:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
   - `crm.schemas.contacts.write` (for custom properties)
4. Create custom properties on the Contact object:
   - `lahzo_score` (Number)
   - `lahzo_status` (Single-line text)
5. Copy the **access token** and **client secret** into your `.env`

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

1. Go to your HubSpot developer account → **Apps** → your private app → **Webhooks**
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
├── IMPLEMENTATION_PLAN.md   # Detailed build plan
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
        ├── pages/            # Login, Dashboard, Contact Detail
        └── components/       # Layout, shared components
```
