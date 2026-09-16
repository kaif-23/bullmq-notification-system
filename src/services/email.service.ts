import { redisClient } from "../config/redis-client.js";
export async function sendEmail(
    email: string,
    idempotencyKey: string,
    timeoutMs = 3000
) {
    console.log(
        `Sending email to ${email} with provider key ${idempotencyKey}`
    );
    const key = `email:idempotency:${idempotencyKey}`;

    const acquired = await redisClient.set(
        key,
        Date.now().toString(),
        "EX",
        3600,
        "NX"
    );

    if (acquired !== "OK") {
        const existingValue = await redisClient.get(key);

        if (existingValue === "sent") {
            console.log(
                `Duplicate email request ignored: ${idempotencyKey}`
            );
            return;
        }

        const processingStartedAt = Number(existingValue);
        const processingAge = Date.now() - processingStartedAt;

        if (processingAge < 30_000) {
            console.log(
                `Email is already being processed: ${idempotencyKey}`
            );
            return;
        }

        console.log(
            `Processing lock is stale, retrying: ${idempotencyKey}`
        );
    }
    await Promise.race([
        new Promise((resolve) =>
            setTimeout(resolve, 100)
        ),

        new Promise((_, reject) =>
            setTimeout(
                () => reject(
                    new Error("Email provider timeout")
                ),
                timeoutMs
            )
        )
    ]);

    console.log(`Email sent to ${email}`);
    await redisClient.set(
        key,
        "sent",
        "EX",
        3600
    );
}