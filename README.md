# BullMQ Email Notification System

A backend email notification system built with **Node.js, TypeScript, PostgreSQL, Redis, and BullMQ** — focused on asynchronous processing, idempotency, retries, failure recovery, and the Transactional Outbox pattern.

---

## Architecture

```
┌─────────────┐
│  Client API │
└──────┬──────┘
       │ HTTP Request
       ▼
┌─────────────┐     ┌──────────────────────────┐
│  Express API │────▶│      PostgreSQL          │
└─────────────┘     │  ┌────────────────────┐   │
                    │  │   notifications    │   │
                    │  ├────────────────────┤   │
                    │  │ notification_outbox│   │
                    │  └────────┬───────────┘   │
                    └───────────┼───────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │     Outbox Relay      │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │   BullMQ + Redis      │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │    Email Worker       │
                    └───────────┬───────────┘
                                │
              ┌─────────────────┴──────────────────┐
              ▼                                     ▼
  ┌─────────────────────┐             ┌─────────────────────┐
  │   Resend Provider   │             │    Mock Provider    │
  └─────────────────────┘             └─────────────────────┘

Failure Flow:
┌──────────────┐    ┌───────────────┐    ┌──────────┐      ┌────────┐
│Worker Failure│───▶│ Retry+Backoff │───▶│   DLQ    │───▶ |Replay │
└──────────────┘    └───────────────┘    └──────────┘      └────────┘
```

---

## How It Works

1. **API** receives an email notification request and persists both the notification and an outbox event to PostgreSQL atomically.
2. **Outbox Relay** polls for pending outbox events and enqueues them as BullMQ jobs.
3. **BullMQ + Redis** manages the job queue and scheduling.
4. **Worker** processes each job and sends the email via the configured provider.
5. **Retries + Backoff** handle transient failures automatically.
6. **DLQ** captures exhausted jobs for manual inspection and replay.

---

## Key Concepts

| Concept | Description |
|---|---|
| **Transactional Outbox** | Atomically write to DB and queue via an outbox table |
| **At-Least-Once Delivery** | Jobs may run more than once; idempotency prevents duplicates |
| **Idempotency** | Guards against duplicate API requests and repeated job execution |
| **Retry & Backoff** | Exponential backoff on transient failures |
| **Dead-Letter Queue** | Stores permanently failed jobs for replay |
| **Provider Abstraction** | Swap between Resend and Mock without code changes |

### Email provider selection

The worker uses simulated delivery by default, which is safe for local
development and tests and does not send real emails. Set
`EMAIL_PROVIDER=simulated` explicitly for simulated delivery.

For actual email delivery, set `EMAIL_PROVIDER=resend` and provide both
`RESEND_API_KEY` and `EMAIL_FROM`. Resend configuration is validated only when
Resend is selected; unsupported provider values and missing Resend settings
fail safely during worker startup.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js, TypeScript |
| API | Express.js |
| Database | PostgreSQL |
| Queue | BullMQ, Redis |
| Email | Resend, Mock Provider |
| Testing | Vitest (Integration Tests) |

---

## Getting Started

```bash
npm install
npm run migrate
```

### Database migrations

`npm run migrate` serializes migration runners with a PostgreSQL advisory lock
named `bullmq-notification-system:migrations`. The lock covers migration file
discovery, checksum verification, and application, so if two deployment
processes start together, one waits and then re-checks the database after the
first finishes. The lock is released on both success and failure.

Each migration and its `schema_migrations` record are committed in the same
transaction. A failed migration is rolled back and is not marked as applied.
Applied migration checksums remain enforced: unchanged files are skipped,
changed files are rejected, and new files are applied in numeric order. The
migration entrypoint also closes its PostgreSQL pool on both success and
failure and exits non-zero after a migration failure.

For compiled production processes, build first and use:

```bash
npm run build
npm start
npm run start:worker
npm run start:relay
npm run start:events
npm run migrate:production
```

The build packages the migration SQL files under `dist/migrations`; the
compiled migration runner resolves them independently of the process working
directory.

### Production environment validation

When `NODE_ENV=production`, startup requires explicit PostgreSQL settings
(`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`) and Redis
settings (`REDIS_HOST` and `REDIS_PORT`). Local hosts, the default `postgres`
credentials, the default `notification_db` database, missing values, and
invalid ports are rejected before connections are created. Development and
test environments retain their existing configuration behavior.

### Docker foundation

The production application image is built with the multi-stage `Dockerfile`.
It compiles TypeScript, packages migrations under `dist/migrations`, installs
only production dependencies in the runtime stage, and runs as the non-root
`node` user. Override the default command to run the separate compiled worker,
relay, events, or migration entrypoints.

The Redis baseline is pinned separately in `docker/redis.Dockerfile` to
`redis:7.4.2-bookworm`, compatible with the BullMQ 6.3.4 deployment baseline.

### Local Docker Compose runtime

Compose runs PostgreSQL, Redis, the API, worker, relay, and queue-events
process as separate services. The local Compose environment uses simulated
email delivery. Compose reads optional `COMPOSE_DB_USER`,
`COMPOSE_DB_PASSWORD`, `COMPOSE_DB_NAME`, and `COMPOSE_INTERNAL_API_KEY`
overrides from the ignored `.env` file. If they are not set, Compose uses
explicit local-only defaults; never reuse those defaults outside local
development.

For local overrides, add these variables to `.env` in the repository root:

```env
COMPOSE_DB_USER=notification_app
COMPOSE_DB_PASSWORD=choose-a-local-only-password
COMPOSE_DB_NAME=notification_production
COMPOSE_INTERNAL_API_KEY=choose-a-local-only-key
```

The committed `.env.example` contains placeholder values for these optional
Compose settings. Do not commit `.env`.

```bash
docker compose build
docker compose up -d postgres redis
docker compose --profile migration run --rm migrations
docker compose up -d api worker relay events
```

The migration service is one-shot and must complete before starting the
application services. Compose health dependencies only wait for PostgreSQL and
Redis health checks; they do not replace the explicit migration step.

The API is available at `http://localhost:3000`. PostgreSQL and Redis use only
the private `bullmq-network` and are addressed internally as `postgres` and
`redis`.

To submit a local simulated notification:

```bash
curl -X POST http://localhost:3000/api/v1/notifications/email `
  -H "Content-Type: application/json" `
  -H "Idempotency-Key: compose-demo-1" `
  -d '{"email":"dev@example.com","type":"compose-demo","data":{"source":"compose"}}'
```

Use the returned `notificationId` with
`GET /api/v1/notifications/{notificationId}` to inspect its status.

Start each process in a separate terminal:

```bash
npm run dev      # Express API
npm run worker   # Email worker
npm run relay    # Outbox relay
npm run events   # Event listener
```

---

## Design Philosophy

> **At-least-once processing + idempotency** instead of exactly-once delivery.

- **PostgreSQL** holds durable business state.
- **Redis / BullMQ** manages ephemeral async job state.
- Failures are expected and handled gracefully through retries, DLQ, and replay.
