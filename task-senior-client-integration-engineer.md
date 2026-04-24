# Senior Client Integration Engineer — Technical Assessment

## Overview

This assessment is designed to evaluate how you design, architect, and implement production-grade integrations between a SaaS platform and external CRM systems.

We are less interested in pixel-perfect UI or production-grade polish.
We are interested in how you think, structure your code, and make architectural decisions under realistic constraints typical of client integration work.

Please assume this integration will eventually operate in production supporting multiple clients at scale.

⏱ Suggested time: 4–6 hours
📦 Submission: GitHub repository or compressed project
📄 Include a short architecture/design document (required)

---

# Scenario

You are building an **integration service** (acting as the "platform side") that syncs with a client's **CRM**. Think of it as the bridge between a customer-facing AI platform and whatever CRM that customer happens to use.

## Data Flow

1. When a **Contact** (or **Lead**) is created or updated in the client's CRM, your integration service must receive the event and sync the record into its internal store.
2. When your service finishes "processing" the Contact (simulated enrichment + scoring — see §1), the updated status and a computed score must be pushed back to the CRM as a custom property on that Contact.
3. An internal operator can open a minimal web interface to view sync history, inspect failures, and re-trigger a sync for a given Contact.

Authentication for the web interface is not required for this exercise.

---

# Environment: What You Will Integrate Against

The "platform" side is whatever **you** build in this exercise — there is no hidden platform API.

For the **CRM side**, pick **one** of the options below. We recommend the first for speed, but any option is acceptable — tell us which one you chose in your README.

## Option A (recommended) — HubSpot Free Developer Account
- Sign up at [developers.hubspot.com](https://developers.hubspot.com/) — free, no credit card, no trial expiry.
- Create a **developer test account** inside the developer portal (this gives you a sandbox CRM with Contacts, Companies, Deals).
- Use HubSpot's **Webhooks API** to subscribe to `contact.creation` and `contact.propertyChange` events. Docs: `https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide`.
- Use HubSpot's **CRM v3 REST API** to read and update Contacts, including writing back a custom property (e.g. `lahzo_score`, `lahzo_status`).
- Expose your local webhook endpoint to HubSpot using `ngrok`, `cloudflared`, or equivalent.

## Option B — Salesforce Developer Edition
- Sign up at [developer.salesforce.com/signup](https://developer.salesforce.com/signup) — free, permanent Developer Org.
- Use **Platform Events**, **Change Data Capture**, or an **Apex trigger + callout** to send Lead/Contact change events to your service. A simple Apex `@future` callout is fine for this exercise.
- Use the Salesforce **REST API** (`/services/data/vXX.0/sobjects/Lead/:id`) to read and update records.

## Option C — Fully mocked CRM
- If you strongly prefer not to sign up for anything, you may mock the CRM with a small local HTTP stub that (a) posts events to your webhook on a timer or on command and (b) accepts `PATCH` calls to record writebacks.
- This is acceptable but you will be expected to simulate the same failure modes we describe in the constraints below (duplicates, out-of-order, rate limits, transient 5xx).

## "Platform" side (what **you** build)
- You build the backend service and the operator UI yourself.
- If it helps during development, you can use a free endpoint like [webhook.site](https://webhook.site/) to inspect payloads before pointing them at your own service.

---

# Requirements

## 1. CRM Integration

Constraints you must design for (these hold for all three options — with HubSpot/Salesforce they reflect real behavior; with the mock you should simulate them):

- The CRM webhook has a **short timeout** (HubSpot's is effectively ~5s) — if you don't return 2xx in time, it retries.
- Enriching and syncing a Contact takes **3–15 seconds** (external enrichment + simulated AI scoring — you may implement this with a `sleep` plus a trivial computation).
- **Duplicate webhook deliveries may occur.**
- **Event ordering is not guaranteed** — an older update may arrive after a newer one.
- CRM API calls are **rate-limited** (HubSpot: 100–150 req/10s per app depending on tier; Salesforce: daily API limits). Design for it.
- The system **must not lose events**, even if downstream processing fails transiently.

## 2. Backend Service

Build a backend service that:

- Receives inbound CRM webhook events
- Persists Contacts and a full sync history (every inbound event + every outbound API call, with timestamps and outcomes)
- Processes each event **asynchronously** (3–15 seconds simulated delay is fine)
- Pushes back a score and status to the CRM via its REST API (as a custom property — e.g., `lahzo_score`)
- Tracks sync status for each record (`received`, `processing`, `synced`, `failed`, `skipped_stale`)
- Handles retries with backoff on transient CRM API errors (5xx, 429)

You are free to choose architectural patterns and structure.

Use **Python or TypeScript** (either is acceptable — pick what lets you move fastest).

You may use **PostgreSQL, MongoDB, Redis, or a combination**. A message queue or lightweight equivalent is encouraged (Redis lists/streams, SQS, RabbitMQ, or even a database-backed job table are all fine).

## 3. Operator Frontend

Build a minimal frontend that allows:

- Viewing a list of Contacts that have been synced
- Clicking into a Contact to see its full sync history (inbound events + outbound calls, with timestamps and statuses)
- Seeing the current sync status and last error (if any)
- Manually re-triggering a sync for a given Contact

UI polish is not important. Structure and clarity are. A plain HTML table is completely fine.

---

# Architecture & Design Document (Required)

Include a short document (Markdown is fine) explaining:

- Your system architecture
- Which CRM option you chose and why
- How you handle the short webhook timeout
- How you decouple event ingestion from processing
- How you prevent duplicate processing (**idempotency**)
- How you handle **out-of-order events** (stale update protection)
- How you ensure events are not lost on failure
- How you handle CRM API rate limits and transient failures
- **Schema mapping**: how you translate between CRM fields and your internal model
- Data modeling decisions
- Tradeoffs you made
- What you would change for production scale (multiple clients, multiple CRMs)

Clarity of reasoning is more important than length.

---

# Technical Expectations

We are evaluating:

- REST API and webhook design quality
- Event-driven architecture decisions
- Data modeling for sync history and auditability
- Schema mapping approach
- Code organization
- Scalability awareness
- Clean, maintainable code
- Testing strategy (brief explanation is sufficient)

---

# Optional (If Time Allows)

- Containerization (Docker) + a `docker-compose` that brings up your stack
- Basic automated tests — at minimum, a test covering idempotent re-delivery of the same webhook event
- A second "CRM adapter" sketch (e.g., if you chose HubSpot, show how a Salesforce adapter would slot in) demonstrating your abstraction
- Monitoring/logging considerations for integration observability (sync lag, failure rate, DLQ)
- Deployment notes

These are optional and should not compromise core implementation quality.

---

# Getting Started Hints (non-prescriptive)

These are just practical hints so you don't lose time on setup — ignore them if you have a preferred path.

- Use `ngrok http 3000` (or `cloudflared tunnel`) to expose your local server so HubSpot/Salesforce can reach it.
- HubSpot developer app webhook subscriptions require an HTTPS URL and target account install — the docs walk you through it in ~10 minutes.
- Feel free to seed your sandbox with a handful of test Contacts rather than typing them in the UI.
