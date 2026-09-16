import { redisClient } from "../config/redis-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SendEmailResult =
    | { status: "sent" }
    | { status: "skipped"; reason: "already_sent" | "already_processing" };

// ─── Lua CAS script ───────────────────────────────────────────────────────────
//
// Atomically replace the stale processing timestamp with a new one,
// but ONLY if the value hasn't changed since we read it.
//
// This prevents the following race:
//   Worker A reads stale value "123" → decides to take over
//   Worker B reads stale value "123" → also decides to take over
//   Both write new timestamps → both proceed to send → duplicate send
//
// With this CAS:
//   Worker A: GET → "123" → EVAL(expect="123", new="456") → returns 1 → proceeds
//   Worker B: GET → "123" → EVAL(expect="123", new="789") → returns 0 → skips
//
// Returns 1 (integer) on successful swap, 0 (integer) if the key changed.
// We use an explicit integer return rather than forwarding SET's "OK" string
// so that the caller can use a strict !== 1 check — this also guards against
// the eval() returning null on a Redis connection error.
const CAS_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
else
  return 0
end
`;

// ─── Provider ────────────────────────────────────────────────────────────────

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
export async function sendEmail(
    email: string,
    idempotencyKey: string,
    timeoutMs = 3000
): Promise<SendEmailResult> {
    console.log(
        `[PROVIDER] Attempting send to ${email} | key: ${idempotencyKey}`
    );

    const key = `email:idempotency:${idempotencyKey}`;
    const now = Date.now().toString();
    const ttlSeconds = "3600";

    // Try to set the key only if it does not exist (NX = "only if Not eXists")
    const acquired = await redisClient.set(key, now, "EX", 3600, "NX");

    if (acquired !== "OK") {
        // Key already exists — read the current value to decide what to do
        const existingValue = await redisClient.get(key);

        if (existingValue === "sent") {
            console.log(
                `[PROVIDER] Already sent — skipping duplicate: ${idempotencyKey}`
            );
            return { status: "skipped", reason: "already_sent" };
        }

        // The value is a timestamp — someone is (or was) processing this
        const processingStartedAt = Number(existingValue);
        const processingAge = Date.now() - processingStartedAt;

        if (processingAge < 30_000) {
            // Still fresh — another worker is actively processing this
            console.log(
                `[PROVIDER] Already being processed (age ${processingAge}ms) — skipping: ${idempotencyKey}`
            );
            return { status: "skipped", reason: "already_processing" };
        }

        // Stale lock — attempt atomic CAS takeover.
        // If existingValue changed between our GET and this EVAL, the CAS
        // returns 0 and we skip — another worker won the race.
        const swapped = await redisClient.eval(
            CAS_SCRIPT,
            1,      // number of KEYS
            key,    // KEYS[1]
            existingValue ?? "", // ARGV[1] — the stale value we observed
            now,    // ARGV[2] — our new processing timestamp
            ttlSeconds // ARGV[3] — TTL
        );

        // swapped === 1    → CAS succeeded, we now own the lock
        // swapped === 0    → another worker replaced the value first, skip
        // swapped === null → Redis error; treat as CAS failure to avoid double-send
        if (swapped !== 1) {
            console.log(
                `[PROVIDER] Stale lock CAS failed — another worker took over: ${idempotencyKey}`
            );
            return { status: "skipped", reason: "already_processing" };
        }

        console.log(
            `[PROVIDER] Stale lock replaced atomically, taking over: ${idempotencyKey}`
        );
    }

    // ── Simulate provider send ────────────────────────────────────────────────
    await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
        new Promise<void>((_, reject) =>
            setTimeout(
                () => reject(new Error("Email provider timeout")),
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
    await redisClient.set(key, "sent", "EX", 3600);

    console.log(`[PROVIDER] Email sent successfully to ${email}`);

    return { status: "sent" };
}