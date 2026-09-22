import { Job, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { emailQueue } from "../queues/email.queue.js";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
import { markNotificationFailed } from "../services/notifications.service.js";
import type { EmailJobData } from "../types/email.types.js";
import { db } from "../config/database.js";

const RECONCILIATION_INTERVAL_MS = 30_000;

// ─── Event listener ───────────────────────────────────────────────────────────

const emailQueueEvents = new QueueEvents("email", {
    connection: redisConnection
});

emailQueueEvents.on("completed", ({ jobId }) => {
    console.log(`[EVENT] Job ${jobId} completed successfully`);
});

async function ensureDlqEntry(
    job: Job<EmailJobData>,
    failedReason: string
): Promise<void> {
    const jobId = job.id;

    if (!jobId) {
        console.warn("[DLQ] Failed job has no ID — skipping");
        return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const attemptsMade = job.attemptsMade;

    if (attemptsMade < maxAttempts) return;

    console.log(
        `[DLQ] Permanent failure detected for job ${jobId} | notificationId: ${job.data.notificationId}`
    );

    // Update notification status in PostgreSQL
    if (job.data.notificationId != null) {
        try {
            await markNotificationFailed(job.data.notificationId);
            console.log(
                `[DLQ] Notification ${job.data.notificationId} marked as failed`
            );
        } catch (error) {
            console.error(
                `[DLQ] Failed to mark notification ${job.data.notificationId} as failed`,
                error
            );
            // Continue — we still want to attempt DLQ insertion
        }
    }

    // ── DLQ insertion ─────────────────────────────────────────────────────────

    // Deterministic job ID based on the original job ID.
    // BullMQ will reject the insert if this ID already exists,
    // which prevents duplicate DLQ entries if this event fires twice.
    const dlqJobId = `dlq-${jobId}`;

    // Carry forward replayCount from the job data (0 for first failure,
    // incremented on each replay cycle so we can cap infinite loops)
    const currentReplayCount = job.data.replayCount ?? 0;

    console.log(
        `[DLQ] Inserting DLQ entry ${dlqJobId} | replayCount: ${currentReplayCount}`
    );

    try {
        await deadLetterEmailQueue.add(
            job.name,
            {
                ...job.data,
                originalJobId: job.id,
                failedReason,
                attemptsMade,
                replayCount: currentReplayCount
            } satisfies EmailJobData,
            {
                jobId: dlqJobId
            }
        );

        console.log(
            `[DLQ] Entry ${dlqJobId} inserted successfully for notificationId: ${job.data.notificationId}`
        );
    } catch (error) {
        // BullMQ throws when a job with the same ID already exists.
        // This can happen if the 'failed' event fires more than once
        // (QueueEvents subscribers can receive duplicate events).
        // Note: We use string matching here because BullMQ does not expose a 
        // public, typed error code for "Job already exists".
        const message = error instanceof Error ? error.message : String(error);

        if (
            message.includes("already exists") ||
            message.includes("Job already exists")
        ) {
            console.log(
                `[DLQ] Duplicate DLQ entry detected — ${dlqJobId} already exists, skipping`
            );
        } else {
            console.error(
                `[DLQ] Unexpected error inserting DLQ entry ${dlqJobId}`,
                error
            );
        }
    }
}

async function processFailedJob(jobId: string, failedReason: string): Promise<void> {
    const job = await Job.fromId<EmailJobData>(emailQueue, jobId);

    if (!job) {
        console.warn(`[DLQ] Job ${jobId} not found — skipping failure handler`);
        return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
        console.log(
            `[EVENT] Job ${jobId} has ${maxAttempts - job.attemptsMade} attempts remaining — will retry`
        );
        return;
    }

    await ensureDlqEntry(job, failedReason);
}

emailQueueEvents.on("failed", ({ jobId, failedReason }) => {
    void processFailedJob(jobId, failedReason).catch((error) => {
        console.error(`[EVENT] Failure handler crashed for job ${jobId}`, error);
    });
});

async function reconcileExhaustedJobs(): Promise<void> {
    const jobs = await emailQueue.getJobs(["failed"], 0, 100);

    for (const job of jobs) {
        const maxAttempts = job.opts.attempts ?? 1;
        if (job.attemptsMade >= maxAttempts && job.id) {
            await processFailedJob(job.id, job.failedReason ?? "Unknown failure");
        }
    }
}

const reconciliationTimer = setInterval(() => {
    void reconcileExhaustedJobs().catch((error) => {
        console.error("[DLQ] Reconciliation failed", error);
    });
}, RECONCILIATION_INTERVAL_MS);

console.log("[EVENT] Email queue event listener started");

let shuttingDown = false;

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconciliationTimer);
    console.log(`[EVENT] Received ${signal} — shutting down gracefully...`);
    await emailQueueEvents.close();
    await emailQueue.close();
    await deadLetterEmailQueue.close();
    await db.end();
    console.log("[EVENT] Event listener shut down cleanly");
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));