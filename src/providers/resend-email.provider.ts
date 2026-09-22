import { loadEmailProviderConfig, type EmailProviderConfig } from "../config/email-provider.js";
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

const RESEND_API_URL = "https://api.resend.com/emails";

type FetchImplementation = typeof fetch;

export class ResendEmailProvider implements EmailProvider {
    private readonly config: EmailProviderConfig;
    private readonly fetchImplementation: FetchImplementation;

    constructor(
        config?: EmailProviderConfig,
        fetchImplementation: FetchImplementation = fetch
    ) {
        try {
            this.config = config ?? loadEmailProviderConfig();
        } catch (cause) {
            throw new EmailProviderError({
                code: "EMAIL_PROVIDER_CONFIGURATION",
                message: "Email provider configuration is invalid",
                retryable: false,
                cause
            });
        }
        this.fetchImplementation = fetchImplementation;
    }

    async send(request: EmailSendRequest): Promise<SendEmailResult> {
        const decision = await acquireEmailIdempotency(request.idempotencyKey);

        if (decision.status === "skipped") {
            return decision.result;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        const body = this.createRequestBody(request);

        try {
            const response = await this.fetchImplementation(RESEND_API_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                    "Content-Type": "application/json",
                    "Idempotency-Key": request.idempotencyKey
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            if (!response.ok) {
                throw this.createResponseError(response.status);
            }

            let responseBody: unknown;
            try {
                responseBody = await response.json();
            } catch (cause) {
                throw new EmailProviderError({
                    code: "EMAIL_PROVIDER_INVALID_RESPONSE",
                    message: "Email provider returned malformed JSON",
                    retryable: true,
                    cause
                });
            }
            const providerMessageId = this.readProviderMessageId(responseBody);
            logInfo("resend_email_provider_sent", {
                provider: "resend",
                providerMessageId,
                idempotencyKey: request.idempotencyKey
            });

            await markEmailIdempotencySent(decision.key);
            return { status: "sent" };
        } catch (error) {
            if (error instanceof EmailProviderError) {
                throw error;
            }

            if (controller.signal.aborted) {
                throw new EmailProviderError({
                    code: "EMAIL_PROVIDER_TIMEOUT",
                    message: "Email provider request timed out",
                    retryable: true,
                    cause: error
                });
            }

            throw new EmailProviderError({
                code: "EMAIL_PROVIDER_NETWORK_ERROR",
                message: "Email provider network request failed",
                retryable: true,
                cause: error
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    private createRequestBody(request: EmailSendRequest): Record<string, unknown> {
        return {
            from: request.from ?? this.config.from,
            to: [request.to],
            subject: request.subject ?? "Notification",
            ...(request.text || !request.html
                ? { text: request.text ?? "Notification" }
                : {}),
            ...(request.html ? { html: request.html } : {})
        };
    }

    private createResponseError(status: number): EmailProviderError {
        if (status === 401 || status === 403) {
            return new EmailProviderError({
                code: "EMAIL_PROVIDER_AUTHENTICATION",
                message: "Email provider authentication failed",
                retryable: false
            });
        }

        if (status === 400 || status === 422) {
            return new EmailProviderError({
                code: "EMAIL_PROVIDER_INVALID_REQUEST",
                message: "Email provider rejected the email request",
                retryable: false
            });
        }

        if (status === 429 || status >= 500) {
            return new EmailProviderError({
                code: "EMAIL_PROVIDER_TEMPORARY_FAILURE",
                message: "Email provider temporarily failed the request",
                retryable: true
            });
        }

        return new EmailProviderError({
            code: "EMAIL_PROVIDER_UNKNOWN",
            message: "Email provider returned an unexpected response",
            retryable: true
        });
    }

    private readProviderMessageId(responseBody: unknown): string {
        if (
            responseBody !== null &&
            typeof responseBody === "object" &&
            "id" in responseBody &&
            typeof responseBody.id === "string" &&
            responseBody.id.length > 0
        ) {
            return responseBody.id;
        }

        throw new EmailProviderError({
            code: "EMAIL_PROVIDER_INVALID_RESPONSE",
            message: "Email provider returned an invalid success response",
            retryable: true
        });
    }
}
