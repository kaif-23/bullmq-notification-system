import { Job, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { emailQueue } from "../queues/email.queue.js";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
import { markNotificationFailed } from "../services/notifications.service.js";
import type { EmailJobData } from "../types/email.types.js";

export const RECONCILIATION_INTERVAL_MS = 30_000;

export async function ensureDlqEntry(
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
        }
    }

    const dlqJobId = `dlq-${jobId}`;
    const currentReplayCount = job.data.replayCount ?? 0;

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
            { jobId: dlqJobId }
        );
    } catch (error) {
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

export async function processFailedJob(
    jobId: string,
    failedReason: string
): Promise<void> {
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

export async function reconcileExhaustedJobs(): Promise<void> {
    const jobs = await emailQueue.getJobs(["failed"], 0, 100);

    for (const job of jobs) {
        const maxAttempts = job.opts.attempts ?? 1;
        if (job.attemptsMade >= maxAttempts && job.id) {
            await processFailedJob(job.id, job.failedReason ?? "Unknown failure");
        }
    }
}

export function createEmailQueueEvents(): QueueEvents {
    const queueEvents = new QueueEvents("email", {
        connection: redisConnection
    });

    queueEvents.on("completed", ({ jobId }) => {
        console.log(`[EVENT] Job ${jobId} completed successfully`);
    });

    queueEvents.on("failed", ({ jobId, failedReason }) => {
        void processFailedJob(jobId, failedReason).catch((error) => {
            console.error(`[EVENT] Failure handler crashed for job ${jobId}`, error);
        });
    });

    return queueEvents;
}
