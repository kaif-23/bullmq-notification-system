import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const deadLetterEmailQueue = new Queue(
    "dead-letter-email",
    {
        connection: redisConnection
    }
);