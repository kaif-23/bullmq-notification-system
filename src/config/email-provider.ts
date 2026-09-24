import "dotenv/config";

export interface EmailProviderConfig {
    apiKey: string;
    from: string;
    timeoutMs: number;
}

function required(name: string, environment: NodeJS.ProcessEnv): string {
    const value = environment[name]?.trim();
    if (!value) {
        throw new Error(`Missing required email provider configuration: ${name}`);
    }
    return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadEmailProviderConfig(
    environment: NodeJS.ProcessEnv = process.env
): EmailProviderConfig {
    return {
        apiKey: required("RESEND_API_KEY", environment),
        from: required("EMAIL_FROM", environment),
        timeoutMs: positiveInteger(environment.EMAIL_PROVIDER_TIMEOUT_MS, 3_000)
    };
}
