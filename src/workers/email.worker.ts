import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";
import {
    claimNotification,
    incrementNotificationAttempts,
    markNotificationSent
} from "../services/notifications.service.js";
import { sendEmail } from "../services/email.service.js";
import type { EmailJobData } from "../types/email.types.js";

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker<EmailJobData>(
    "email",
    async (job) => {
        const start = Date.now();
        const attempt = job.attemptsMade + 1;
        const maxAttempts = job.opts.attempts ?? 1;

        console.log(
            `[WORKER] Job ${job.id} started | attempt ${attempt}/${maxAttempts} | notificationId: ${job.data.notificationId ?? "none"}`
        );

        // ── Skip DB tracking for jobs without a notificationId ───────────────
        // This handles test routes that enqueue jobs directly without
        // creating a notification row first (e.g. GET /, /test-bulk).
        if (job.data.notificationId == null) {
            console.log(
                `[WORKER] Job ${job.id} has no notificationId — skipping DB tracking`
            );

            // Still simulate sending the email for test purposes
            if (job.data.shouldFail || job.data.simulateTransientFailure) {
                throw new Error("Simulated email failure (no notificationId)");
            }

            console.log(
                `[WORKER] Job ${job.id} completed (no DB tracking)`
            );
            return;
        }

        // ── Claim the notification ────────────────────────────────────────────
        //
        // First attempt: requires status = 'pending'
        // Retry:         also allows status = 'processing'
        //                (the previous attempt threw, leaving it in processing)
        //
        // If claim fails:
        //   - Another worker already owns this notification (concurrent workers)
        //   - Or the notification was already sent (idempotency guard)
        // In both cases, skip without error.
        const isRetry = job.attemptsMade > 0;

        const claimed = await claimNotification(
            job.data.notificationId,
            isRetry
        );

        if (!claimed) {
            console.log(
                `[WORKER] Job ${job.id} — notification ${job.data.notificationId} already claimed or sent, skipping`
            );
            return;
        }

        // ── Increment business attempts counter ───────────────────────────────
        //
        // This tracks actual processing attempts at the business level,
        // separate from BullMQ's job.attemptsMade (which tracks queue retries).
        await incrementNotificationAttempts(job.data.notificationId);

        // ── Send the email ────────────────────────────────────────────────────
        try {
            console.log(
                `[WORKER] Job ${job.id} — sending email to ${job.data.email}`
            );

            // shouldFail: true simulates permanent failure on all attempts
            // (used by /test-failure-event and /test-db-failure routes)
            if (job.data.shouldFail) {
                throw new Error("Simulated permanent email failure");
            }

            // simulateTransientFailure: true only fails on the first attempt
            if (job.data.simulateTransientFailure && job.attemptsMade === 0) {
                throw new Error("Simulated transient email failure");
            }

            // Provider idempotency key: stable across retries and replays
            // because it is based on the notification ID, not the job ID.
            const providerKey = `notification-${job.data.notificationId}`;

            const result = await sendEmail(job.data.email, providerKey);

            if (result.status === "skipped" && result.reason === "already_processing") {
                // Another worker is actively inside the provider send right now
                // (Redis lock age < 30s). Marking the notification as sent here
                // would be premature — the owning worker may still fail, and we
                // would have incorrectly declared the operation complete.
                //
                // Throw so BullMQ treats this attempt as failed and retries it
                // according to the existing backoff configuration. By the time
                // the retry runs, the other worker will have either:
                //   a) succeeded → provider returns "already_sent" → we mark sent safely
                //   b) failed    → lock becomes stale → CAS takeover → we send ourselves
                console.log(
                    `[WORKER] Job ${job.id} — notification ${job.data.notificationId} is currently being processed by another worker, retrying later`
                );
                throw new Error(
                    `Notification ${job.data.notificationId} is already being processed by another worker`
                );
            }

            // At this point result is either:
            //   { status: "sent" }                             — provider just sent it
            //   { status: "skipped", reason: "already_sent" }  — provider confirms prior delivery
            // Both outcomes mean the email has been delivered. Mark the notification sent.
            if (result.status === "skipped") {
                // reason must be "already_sent" here (already_processing was handled above)
                console.log(
                    `[WORKER] Job ${job.id} — provider confirms email already sent, marking sent`
                );
            }

            // Mark notification as sent in PostgreSQL.
            // Failure window: if we crash here after the provider sends
            // but before this update, the notification stays 'processing'.
            // On retry, claimNotification allows re-claiming 'processing',
            // and the provider idempotency key returns 'skipped' (already_sent),
            // so we correctly mark it sent without re-sending.
            await markNotificationSent(job.data.notificationId);

            const duration = Date.now() - start;
            console.log(
                `[WORKER] Job ${job.id} completed in ${duration}ms`
            );
        } catch (error) {
            console.error(
                `[WORKER] Job ${job.id} failed on attempt ${attempt}/${maxAttempts}`,
                error instanceof Error ? error.message : error
            );

            // Re-throw so BullMQ records the failure and schedules a retry.
            // The notification remains in 'processing' state between retries.
            // email.events.ts handles the 'failed' event after all attempts
            // are exhausted and marks the notification as 'failed'.
            throw error;
        }
    },
    {
        connection: redisConnection,
        concurrency: 2,
        limiter: {
            max: 2,
            duration: 1000
        }
    }
);

console.log("[WORKER] Email worker started");

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
    console.log(`[WORKER] Received ${signal} — shutting down gracefully...`);
    await worker.close();
    console.log("[WORKER] Worker shut down cleanly");
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));