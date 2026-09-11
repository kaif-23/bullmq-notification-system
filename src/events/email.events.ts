import { QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis.js";

const emailQueueEvents = new QueueEvents("email", {
    connection: redisConnection
});

emailQueueEvents.on("completed", ({ jobId }) => {
    console.log(`[EVENT] Job ${jobId} completed`);
});

emailQueueEvents.on("failed", ({ jobId, failedReason }) => {
    console.log(
        `[EVENT] Job ${jobId} failed: ${failedReason}`
    );
});

console.log("Email queue event listener started");