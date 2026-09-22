import { EmailProviderError } from "../errors/email-provider.error.js";
import {
    acquireEmailIdempotency,
    markEmailIdempotencySent
} from "./email-idempotency.js";
import { logInfo } from "../utils/logger.js";
import type {
    EmailProvider,
    EmailSendRequest,
    SendEmailResult
} from "../types/email-provider.types.js";

export class SimulatedEmailProvider implements EmailProvider {
    /**
     * Simulates sending an email with provider-level idempotency.
     *
     * The Redis key `email:idempotency:<idempotencyKey>` stores one of:
     *   - A Unix timestamp (ms) string: the email is currently being processed
     *   - The string "sent": the email was successfully sent
     *
     * This protects against:
     *   - Duplicate sends when the same job is retried (same idempotencyKey)
     *   - Concurrent workers racing on the same notification
     *
     * Known limitation: If Redis restarts and loses the key, a retry will
     * re-send the email. In production, use Redis with AOF persistence or
     * a real provider that maintains its own idempotency log.
     */
    async send(
        request: EmailSendRequest,
        timeoutMs = 3000
    ): Promise<SendEmailResult> {
        logInfo("simulated_email_provider_send_started", {
            provider: "simulated",
            idempotencyKey: request.idempotencyKey
        });

        const decision = await acquireEmailIdempotency(request.idempotencyKey);

        if (decision.status === "skipped") {
            if (decision.result.reason === "already_sent") {
                logInfo("simulated_email_provider_skipped", {
                    provider: "simulated",
                    idempotencyKey: request.idempotencyKey,
                    reason: "already_sent"
                });
            } else {
                logInfo("simulated_email_provider_skipped", {
                    provider: "simulated",
                    idempotencyKey: request.idempotencyKey,
                    reason: "already_processing"
                });
            }
            return decision.result;
        }

        // ── Simulate provider send ────────────────────────────────────────────
        await Promise.race([
            new Promise<void>((resolve) => setTimeout(resolve, 100)),
            new Promise<void>((_, reject) =>
                setTimeout(
                    () => reject(new EmailProviderError({
                        code: "EMAIL_PROVIDER_TIMEOUT",
                        message: "Email provider timeout",
                        retryable: true
                    })),
                    timeoutMs
                )
            )
        ]);

        // Mark as permanently sent AFTER the provider confirms delivery.
        // Failure window: if we crash here after the provider sends but before
        // this Redis write, a retry will re-enter the provider. Because the
        // Redis key still holds a timestamp (not "sent"), the CAS will see a
        // stale lock and take over — and the provider call runs again.
        // In production this is handled by the provider's own idempotency key.
        await markEmailIdempotencySent(decision.key);

        logInfo("simulated_email_provider_sent", {
            provider: "simulated",
            idempotencyKey: request.idempotencyKey
        });

        return { status: "sent" };
    }
}

export const emailProvider = new SimulatedEmailProvider();
