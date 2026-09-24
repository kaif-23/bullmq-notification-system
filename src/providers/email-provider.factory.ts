import { loadEmailProviderConfig } from "../config/email-provider.js";
import { EmailProviderError } from "../errors/email-provider.error.js";
import type { EmailProvider } from "../types/email-provider.types.js";
import { ResendEmailProvider } from "./resend-email.provider.js";
import { SimulatedEmailProvider } from "./simulated-email.provider.js";

export type EmailProviderName = "simulated" | "resend";

export function createEmailProvider(
    environment: NodeJS.ProcessEnv = process.env
): EmailProvider {
    const configuredProvider = environment.EMAIL_PROVIDER?.trim().toLowerCase();
    const provider = configuredProvider || "simulated";

    if (provider === "simulated") {
        return new SimulatedEmailProvider();
    }

    if (provider === "resend") {
        try {
            return new ResendEmailProvider(loadEmailProviderConfig(environment));
        } catch (cause) {
            if (cause instanceof EmailProviderError) {
                throw cause;
            }

            throw new EmailProviderError({
                code: "EMAIL_PROVIDER_CONFIGURATION",
                message: "Email provider configuration is invalid",
                retryable: false,
                cause
            });
        }
    }

    throw new EmailProviderError({
        code: "EMAIL_PROVIDER_CONFIGURATION",
        message: "Unsupported EMAIL_PROVIDER; expected simulated or resend",
        retryable: false
    });
}
