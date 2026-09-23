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
import { logError, logInfo, safeErrorContext } from "../utils/logger.js";
import { incrementCounter, observeTiming } from "../utils/metrics.js";

function providerName(provider: EmailProvider): "simulated" | "resend" | "other" {
    const name = provider.constructor.name.toLowerCase();
    if (name.includes("resend")) return "resend";
    if (name.includes("simulated")) return "simulated";
    return "other";
}

function providerErrorCategory(code: string): string {
    if (code.includes("TIMEOUT")) return "timeout";
    if (code.includes("NETWORK")) return "network";
    if (code.includes("TEMPORARY")) return "temporary";
    if (code.includes("AUTHENTICATION")) return "authentication";
    if (code.includes("INVALID_REQUEST")) return "invalid_request";
    return "unknown";
}

export async function processEmailJob(
    job: Job<EmailJobData>,
    provider: EmailProvider = emailProvider
): Promise<void> {
    const start = Date.now();
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const selectedProvider = providerName(provider);
    let providerStart = 0;

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
        providerStart = Date.now();
        const result = await provider.send(emailRequest);
        observeTiming("provider_request_duration", Date.now() - providerStart, {
            provider: selectedProvider
        });

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
        incrementCounter("notifications_sent_total");

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
            ...safeErrorContext(error)
        });

        if (providerStart > 0) {
            observeTiming("provider_request_duration", Date.now() - providerStart, {
                provider: selectedProvider
            });
        }

        if (error instanceof EmailProviderError) {
            const labels = {
                provider: selectedProvider,
                errorCategory: providerErrorCategory(error.code)
            } as const;
            incrementCounter("provider_failures_total", labels);
            incrementCounter(
                error.retryable
                    ? "provider_retryable_failures_total"
                    : "provider_permanent_failures_total",
                labels
            );
            if (!error.retryable) incrementCounter("notifications_failed_total");
        }

        if (error instanceof EmailProviderError && !error.retryable) {
            await job.updateData({
                ...job.data,
                permanentFailure: true,
                failureCode: error.code
            });
            error.name = UnrecoverableError.name;
        }

        throw error;
    } finally {
        observeTiming("notification_processing_duration", Date.now() - start);
    }
}