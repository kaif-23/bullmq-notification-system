import { describe, expect, it, vi } from "vitest";
import { EmailProviderError } from "../../src/errors/email-provider.error.js";
import { ResendEmailProvider } from "../../src/providers/resend-email.provider.js";
import type { EmailProviderConfig } from "../../src/config/email-provider.js";
import type { EmailSendRequest } from "../../src/types/email-provider.types.js";

type FetchMock = (
    input: RequestInfo | URL,
    init?: RequestInit
) => Promise<Response>;

const config: EmailProviderConfig = {
    apiKey: "re_test_secret",
    from: "notifications@example.com",
    timeoutMs: 50
};

function request(): EmailSendRequest {
    return {
        to: "recipient@example.com",
        idempotencyKey: `notification-${crypto.randomUUID()}`,
        from: "sender@example.com",
        subject: "Account verification",
        text: "Verify your account",
        html: "<p>Verify your account</p>"
    };
}

function response(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    } as Response;
}

describe("ResendEmailProvider", () => {
    it("constructs the Resend request and returns sent", async () => {
        const logSpy = vi.spyOn(console, "log");
        let receivedUrl: RequestInfo | URL | undefined;
        let receivedInit: RequestInit | undefined;
        const provider = new ResendEmailProvider(config, async (url, init) => {
            receivedUrl = url;
            receivedInit = init;
            return response(200, { id: "resend-message-1" });
        });
        const emailRequest = request();

        await expect(provider.send(emailRequest)).resolves.toEqual({ status: "sent" });

        expect(receivedUrl).toBe("https://api.resend.com/emails");
        expect(receivedInit?.method).toBe("POST");
        expect(receivedInit?.headers).toEqual({
            Authorization: "Bearer re_test_secret",
            "Content-Type": "application/json",
            "Idempotency-Key": emailRequest.idempotencyKey
        });
        expect(JSON.parse(receivedInit?.body as string)).toEqual({
            from: "sender@example.com",
            to: ["recipient@example.com"],
            subject: "Account verification",
            text: "Verify your account",
            html: "<p>Verify your account</p>"
        });
        const logOutput = logSpy.mock.calls.map(([entry]) => String(entry)).join("\n");
        expect(logOutput).toContain("resend-message-1");
        expect(logOutput).not.toContain("re_test_secret");
        expect(logOutput).not.toContain("Verify your account");
    });

    it("translates an aborted request into a retryable timeout", async () => {
        const provider = new ResendEmailProvider(
            { ...config, timeoutMs: 1 },
            async (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(new DOMException("aborted", "AbortError"));
                    });
                })
        );

        await expect(provider.send(request())).rejects.toMatchObject({
            name: "EmailProviderError",
            code: "EMAIL_PROVIDER_TIMEOUT",
            retryable: true
        });
    });

    it("translates network failures into retryable errors", async () => {
        const provider = new ResendEmailProvider(config, async () => {
            throw new Error("connection refused");
        });

        await expect(provider.send(request())).rejects.toMatchObject({
            code: "EMAIL_PROVIDER_NETWORK_ERROR",
            retryable: true
        });
    });

    it("translates temporary provider failures into retryable errors", async () => {
        const provider = new ResendEmailProvider(config, async () => response(503, {}));

        await expect(provider.send(request())).rejects.toMatchObject({
            code: "EMAIL_PROVIDER_TEMPORARY_FAILURE",
            retryable: true
        });
    });

    it("translates invalid requests into permanent errors", async () => {
        const provider = new ResendEmailProvider(config, async () => response(422, {}));

        await expect(provider.send(request())).rejects.toMatchObject({
            code: "EMAIL_PROVIDER_INVALID_REQUEST",
            retryable: false
        });
    });

    it("translates authentication failures into permanent errors", async () => {
        const provider = new ResendEmailProvider(config, async () => response(401, {}));

        await expect(provider.send(request())).rejects.toMatchObject({
            code: "EMAIL_PROVIDER_AUTHENTICATION",
            retryable: false
        });
    });

    it("rejects malformed successful responses as retryable errors", async () => {
        const provider = new ResendEmailProvider(config, async () => response(200, {}));

        await expect(provider.send(request())).rejects.toMatchObject({
            code: "EMAIL_PROVIDER_INVALID_RESPONSE",
            retryable: true
        });
    });

    it("translates malformed JSON into a retryable invalid-response error", async () => {
        const provider = new ResendEmailProvider(config, async () => ({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError("invalid JSON");
            }
        } as Response));

        await expect(provider.send(request())).rejects.toMatchObject({
            code: "EMAIL_PROVIDER_INVALID_RESPONSE",
            retryable: true
        });
    });

    it("reports missing configuration without exposing secrets", () => {
        const originalApiKey = process.env.RESEND_API_KEY;
        const originalFrom = process.env.EMAIL_FROM;
        delete process.env.RESEND_API_KEY;
        delete process.env.EMAIL_FROM;

        try {
            expect(() => new ResendEmailProvider()).toThrow(EmailProviderError);
            expect(() => new ResendEmailProvider()).toThrow(
                "Email provider configuration is invalid"
            );
        } finally {
            if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
            else process.env.RESEND_API_KEY = originalApiKey;
            if (originalFrom === undefined) delete process.env.EMAIL_FROM;
            else process.env.EMAIL_FROM = originalFrom;
        }
    });
});
