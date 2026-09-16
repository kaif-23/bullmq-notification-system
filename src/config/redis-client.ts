import IORedis from "ioredis";
import { redisConnection } from "./redis.js";

export const redisClient = new IORedis({
    ...redisConnection,
    maxRetriesPerRequest: null
});