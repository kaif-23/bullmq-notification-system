import { createHash } from "node:crypto";

export interface EmailNotificationRequest {
    email: string;
    type: string;
    data: Record<string, unknown>;
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nestedValue]) => [key, sortKeys(nestedValue)])
        );
    }

    return value;
}

export function fingerprintEmailNotification(
    request: EmailNotificationRequest
): string {
    const canonicalRequest = JSON.stringify(sortKeys(request));
    return createHash("sha256").update(canonicalRequest).digest("hex");
}
