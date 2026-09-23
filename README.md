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
┌──────────────┐    ┌───────────────┐    ┌──────────┐    ┌────────┐
│Worker Failure│───▶│ Retry+Backoff │───▶│   DLQ    │───▶│ Replay │
└──────────────┘    └───────────────┘    └──────────┘    └────────┘
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
