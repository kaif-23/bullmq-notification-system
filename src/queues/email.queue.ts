import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";

export const emailQueue = new Queue("email", {
    connection: redisConnection
});