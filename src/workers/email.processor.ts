import type { Job } from "bullmq";
import {
    claimNotification,
    incrementNotificationAttempts,
    markNotificationSent
} from "../services/notifications.service.js";
import { sendEmail } from "../services/email.service.js";
import type { EmailJobData } from "../types/email.types.js";

export type SendEmailImplementation = typeof sendEmail;

export async function processEmailJob(
    job: Job<EmailJobData>,
    sendEmailImplementation: SendEmailImplementation = sendEmail
): Promise<void> {
    const start = Date.now();
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    console.log(
        `[WORKER] Job ${job.id} started | attempt ${attempt}/${maxAttempts} | notificationId: ${job.data.notificationId} | requestId: ${job.data.requestId ?? "none"}`
    );

    const isRetry = job.attemptsMade > 0;
    const claimed = await claimNotification(job.data.notificationId, isRetry);

    if (!claimed) {
        console.log(
            `[WORKER] Job ${job.id} — notification ${job.data.notificationId} already claimed or sent, skipping`
        );
        return;
    }

    await incrementNotificationAttempts(job.data.notificationId);

    try {
        console.log(
            `[WORKER] Job ${job.id} — sending email to ${job.data.email}`
        );

        const providerKey = `notification-${job.data.notificationId}`;
        const result = await sendEmailImplementation(job.data.email, providerKey);

        if (result.status === "skipped" && result.reason === "already_processing") {
            console.log(
                `[WORKER] Job ${job.id} — notification ${job.data.notificationId} is currently being processed by another worker, retrying later`
            );
            throw new Error(
                `Notification ${job.data.notificationId} is already being processed by another worker`
            );
        }

        if (result.status === "skipped") {
            console.log(
                `[WORKER] Job ${job.id} — provider confirms email already sent, marking sent`
            );
        }

        await markNotificationSent(job.data.notificationId);

        console.log(
            `[WORKER] Job ${job.id} completed in ${Date.now() - start}ms`
        );
    } catch (error) {
        console.error(
            `[WORKER] Job ${job.id} failed on attempt ${attempt}/${maxAttempts}`,
            error instanceof Error ? error.message : error
        );
        throw error;
    }
}