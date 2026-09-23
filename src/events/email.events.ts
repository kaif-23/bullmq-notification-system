import { Job, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { emailQueue } from "../queues/email.queue.js";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
import { markNotificationFailed } from "../services/notifications.service.js";
import type { EmailJobData } from "../types/email.types.js";
import { logError, logInfo, logWarn, safeErrorContext } from "../utils/logger.js";
import { incrementCounter } from "../utils/metrics.js";

export const RECONCILIATION_INTERVAL_MS = 30_000;

export async function ensureDlqEntry(
    job: Job<EmailJobData>,
    failedReason: string
): Promise<void> {
    const jobId = job.id;

    if (!jobId) {
        logWarn("dlq_failed_job_missing_id");
        return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const attemptsMade = job.attemptsMade;

    if (attemptsMade < maxAttempts && !job.data.permanentFailure) return;

    logInfo("dlq_permanent_failure_detected", {
        jobId,
        notificationId: job.data.notificationId,
        outboxEventId: null,
        attemptsMade,
        failureCode: job.data.failureCode ?? null
    });

    if (job.data.notificationId != null) {
        try {
            await markNotificationFailed(job.data.notificationId);
            logInfo("notification_marked_failed", {
                jobId,
                notificationId: job.data.notificationId
            });
        } catch (error) {
            logError("notification_mark_failed_error", {
                jobId,
                notificationId: job.data.notificationId,
                ...safeErrorContext(error)
            });
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
        incrementCounter("dlq_entries_total");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (
            message.includes("already exists") ||
            message.includes("Job already exists")
        ) {
            logInfo("dlq_entry_duplicate", { jobId, dlqJobId });
        } else {
            logError("dlq_entry_create_failed", {
                jobId,
                dlqJobId,
                ...safeErrorContext(error)
            });
        }
    }
}

export async function processFailedJob(
    jobId: string,
    failedReason: string
): Promise<void> {
    const job = await Job.fromId<EmailJobData>(emailQueue, jobId);

    if (!job) {
        logWarn("dlq_failed_job_not_found", { jobId });
        return;
    }

    logInfo("email_job_failure_observed", {
        jobId,
        notificationId: job.data.notificationId,
        requestId: job.data.requestId ?? null,
        attempt: job.attemptsMade,
        failureCode: job.data.failureCode ?? null,
        permanentFailure: job.data.permanentFailure ?? false
    });

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts && !job.data.permanentFailure) {
        logInfo("email_job_retry_pending", {
            jobId,
            notificationId: job.data.notificationId,
            attemptsMade: job.attemptsMade,
            remainingAttempts: maxAttempts - job.attemptsMade
        });
        return;
    }

    await ensureDlqEntry(job, failedReason);
}

export async function reconcileExhaustedJobs(): Promise<void> {
    const jobs = await emailQueue.getJobs(["failed"], 0, 100);

    for (const job of jobs) {
        const maxAttempts = job.opts.attempts ?? 1;
        if ((job.attemptsMade >= maxAttempts || job.data.permanentFailure) && job.id) {
            await processFailedJob(job.id, job.failedReason ?? "Unknown failure");
        }
    }
}

export function createEmailQueueEvents(): QueueEvents {
    const queueEvents = new QueueEvents("email", {
        connection: redisConnection
    });

    queueEvents.on("completed", ({ jobId }) => {
        void Job.fromId<EmailJobData>(emailQueue, jobId).then((job) => {
            logInfo("email_job_event_completed", {
                jobId,
                notificationId: job?.data.notificationId ?? null,
                requestId: job?.data.requestId ?? null
            });
        }).catch((error) => {
            logError("email_job_event_lookup_failed", {
                jobId,
                ...safeErrorContext(error)
            });
        });
    });

    queueEvents.on("failed", ({ jobId, failedReason }) => {
        void processFailedJob(jobId, failedReason).catch((error) => {
            logError("email_job_failure_handler_crashed", {
                jobId,
                ...safeErrorContext(error)
            });
        });
    });

    return queueEvents;
}
