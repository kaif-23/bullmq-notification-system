import "dotenv/config";

export interface EmailProviderConfig {
    apiKey: string;
    from: string;
    timeoutMs: number;
}

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required email provider configuration: ${name}`);
    }
    return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadEmailProviderConfig(): EmailProviderConfig {
    return {
        apiKey: required("RESEND_API_KEY"),
        from: required("EMAIL_FROM"),
        timeoutMs: positiveInteger(process.env.EMAIL_PROVIDER_TIMEOUT_MS, 3_000)
    };
}
