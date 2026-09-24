import { describe, expect, it } from "vitest";
import { EmailProviderError } from "../../src/errors/email-provider.error.js";
import { createEmailProvider } from "../../src/providers/email-provider.factory.js";
import { ResendEmailProvider } from "../../src/providers/resend-email.provider.js";
import { SimulatedEmailProvider } from "../../src/providers/simulated-email.provider.js";

describe("email provider selection", () => {
    it("defaults to simulated without Resend credentials", () => {
        const provider = createEmailProvider({});

        expect(provider).toBeInstanceOf(SimulatedEmailProvider);
    });

    it("selects simulated when configured", () => {
        const provider = createEmailProvider({ EMAIL_PROVIDER: "simulated" });

        expect(provider).toBeInstanceOf(SimulatedEmailProvider);
    });

    it("selects Resend when configured with its credentials", () => {
        const provider = createEmailProvider({
            EMAIL_PROVIDER: "resend",
            RESEND_API_KEY: "re_test_key",
            EMAIL_FROM: "notifications@example.com"
        });

        expect(provider).toBeInstanceOf(ResendEmailProvider);
    });

    it("rejects Resend mode when credentials are missing", () => {
        expect(() => createEmailProvider({ EMAIL_PROVIDER: "resend" })).toThrow(
            EmailProviderError
        );
        expect(() => createEmailProvider({ EMAIL_PROVIDER: "resend" })).toThrow(
            "Email provider configuration is invalid"
        );
    });

    it("rejects unsupported provider values", () => {
        expect(() =>
            createEmailProvider({ EMAIL_PROVIDER: "mailgun" })
        ).toThrow("Unsupported EMAIL_PROVIDER");
    });
});
