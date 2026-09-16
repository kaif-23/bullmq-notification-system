import { Job, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { emailQueue } from "../queues/email.queue.js";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
import { markNotificationFailed } from "../services/notifications.service.js";
import type { EmailJobData } from "../types/email.types.js";

// ─── Event listener ───────────────────────────────────────────────────────────

const emailQueueEvents = new QueueEvents("email", {
    connection: redisConnection
});

emailQueueEvents.on("completed", ({ jobId }) => {
    console.log(`[EVENT] Job ${jobId} completed successfully`);
});

emailQueueEvents.on("failed", async ({ jobId, failedReason }) => {
    const job = await Job.fromId<EmailJobData>(emailQueue, jobId);

    if (!job) {
        console.warn(`[EVENT] Job ${jobId} not found — skipping failure handler`);
        return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const { attemptsMade } = job;

    console.log(
        `[EVENT] Job ${jobId} failed | attempt ${attemptsMade}/${maxAttempts} | reason: ${failedReason}`
    );

    // Only act on permanent failure (all attempts exhausted)
    if (attemptsMade < maxAttempts) {
        console.log(
            `[EVENT] Job ${jobId} has ${maxAttempts - attemptsMade} attempts remaining — will retry`
        );
        return;
    }

    // ── Permanent failure ─────────────────────────────────────────────────────

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
                attemptsMade: job.attemptsMade,
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
});

console.log("[EVENT] Email queue event listener started");