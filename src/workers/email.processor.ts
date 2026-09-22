import { UnrecoverableError, type Job } from "bullmq";
import { EmailProviderError } from "../errors/email-provider.error.js";
import {
    claimNotification,
    incrementNotificationAttempts,
    markNotificationSent
} from "../services/notifications.service.js";
import { emailProvider } from "../providers/simulated-email.provider.js";
import type {
    EmailProvider,
    EmailSendRequest
} from "../types/email-provider.types.js";
import type { EmailJobData } from "../types/email.types.js";
import { logError, logInfo } from "../utils/logger.js";

export async function processEmailJob(
    job: Job<EmailJobData>,
    provider: EmailProvider = emailProvider
): Promise<void> {
    const start = Date.now();
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    logInfo("email_job_started", {
        jobId: job.id,
        notificationId: job.data.notificationId,
        requestId: job.data.requestId ?? null,
        attempt,
        maxAttempts
    });

    const isRetry = job.attemptsMade > 0;
    const claimed = await claimNotification(job.data.notificationId, isRetry);

    if (!claimed) {
        logInfo("email_job_skipped", {
            jobId: job.id,
            notificationId: job.data.notificationId,
            requestId: job.data.requestId ?? null,
            reason: "notification_not_claimed"
        });
        return;
    }

    await incrementNotificationAttempts(job.data.notificationId);

    try {
        logInfo("email_provider_call_started", {
            jobId: job.id,
            notificationId: job.data.notificationId,
            requestId: job.data.requestId ?? null
        });

        const providerKey = `notification-${job.data.notificationId}`;
        const emailRequest: EmailSendRequest = {
            to: job.data.email,
            idempotencyKey: providerKey
        };
        const result = await provider.send(emailRequest);

        if (result.status === "skipped" && result.reason === "already_processing") {
            logInfo("email_job_retryable_skip", {
                jobId: job.id,
                notificationId: job.data.notificationId,
                requestId: job.data.requestId ?? null,
                reason: "already_processing"
            });
            throw new Error(
                `Notification ${job.data.notificationId} is already being processed by another worker`
            );
        }

        if (result.status === "skipped") {
            logInfo("email_provider_already_sent", {
                jobId: job.id,
                notificationId: job.data.notificationId,
                requestId: job.data.requestId ?? null
            });
        }

        await markNotificationSent(job.data.notificationId);

        logInfo("email_job_completed", {
            jobId: job.id,
            notificationId: job.data.notificationId,
            requestId: job.data.requestId ?? null,
            durationMs: Date.now() - start
        });
    } catch (error) {
        logError("email_job_failed", {
            jobId: job.id,
            notificationId: job.data.notificationId,
            requestId: job.data.requestId ?? null,
            attempt,
            maxAttempts,
            errorCode: error instanceof EmailProviderError ? error.code : "UNKNOWN_ERROR",
            retryable: error instanceof EmailProviderError ? error.retryable : null,
            errorMessage: error instanceof Error ? error.message : String(error)
        });

        if (error instanceof EmailProviderError && !error.retryable) {
            await job.updateData({
                ...job.data,
                permanentFailure: true,
                failureCode: error.code
            });
            error.name = UnrecoverableError.name;
        }

        throw error;
    }
}