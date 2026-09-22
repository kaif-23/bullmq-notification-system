import { redisClient } from "../../src/config/redis-client.js";

export async function verifyRedisConnection(): Promise<void> {
    const response = await redisClient.ping();
    if (response !== "PONG") {
        throw new Error(`Unexpected Redis ping response: ${response}`);
    }

    if (redisClient.options.db !== Number(process.env.TEST_REDIS_DB)) {
        throw new Error(
            `Connected to Redis database ${redisClient.options.db ?? 0}, expected ${process.env.TEST_REDIS_DB}`
        );
    }
}

export async function cleanTestRedisKeys(): Promise<void> {
    let cursor = "0";
    do {
        const [nextCursor, keys] = await redisClient.scan(
            cursor,
            "MATCH",
            "email:idempotency:*",
            "COUNT",
            "100"
        );
        cursor = nextCursor;
        if (keys.length > 0) {
            await redisClient.unlink(...keys);
        }
    } while (cursor !== "0");
}

export async function closeTestRedis(): Promise<void> {
    await redisClient.quit();
}
