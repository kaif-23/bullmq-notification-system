import { redisClient } from "../config/redis-client.js";
import type { SendEmailResult } from "../types/email-provider.types.js";

const CAS_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
else
  return 0
end
`;

export type EmailIdempotencyDecision =
    | { status: "acquired"; key: string }
    | { status: "skipped"; result: Extract<SendEmailResult, { status: "skipped" }> };

export async function acquireEmailIdempotency(
    idempotencyKey: string
): Promise<EmailIdempotencyDecision> {
    const key = `email:idempotency:${idempotencyKey}`;
    const now = Date.now().toString();
    const ttlSeconds = "3600";
    const acquired = await redisClient.set(key, now, "EX", 3600, "NX");

    if (acquired === "OK") {
        return { status: "acquired", key };
    }

    const existingValue = await redisClient.get(key);

    if (existingValue === "sent") {
        return {
            status: "skipped",
            result: { status: "skipped", reason: "already_sent" }
        };
    }

    const processingStartedAt = Number(existingValue);
    const processingAge = Date.now() - processingStartedAt;

    if (processingAge < 30_000) {
        return {
            status: "skipped",
            result: { status: "skipped", reason: "already_processing" }
        };
    }

    const swapped = await redisClient.eval(
        CAS_SCRIPT,
        1,
        key,
        existingValue ?? "",
        now,
        ttlSeconds
    );

    if (swapped !== 1) {
        return {
            status: "skipped",
            result: { status: "skipped", reason: "already_processing" }
        };
    }

    return { status: "acquired", key };
}

export async function markEmailIdempotencySent(key: string): Promise<void> {
    await redisClient.set(key, "sent", "EX", 3600);
}
