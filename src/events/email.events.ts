import { Job, QueueEvents } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { db } from "../config/database.js";
import { emailQueue } from "../queues/email.queue.js";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
const emailQueueEvents = new QueueEvents("email", {
    connection: redisConnection
});

emailQueueEvents.on("completed", ({ jobId }) => {
    console.log(`[EVENT] Job ${jobId} completed`);
});

emailQueueEvents.on("failed", async ({ jobId, failedReason }) => {
    const job = await Job.fromId(emailQueue, jobId);

    if (!job) {
        console.log(`[EVENT] Job ${jobId} not found`);
        return;
    }

    const maxAttempts = job.opts.attempts ?? 1;

    console.log(`[EVENT] Job ${jobId} failed`);
    console.log(`Attempts made: ${job.attemptsMade}`);
    console.log(`Maximum attempts: ${maxAttempts}`);

    if (job.attemptsMade >= maxAttempts) {
        await db.query(
            `
            UPDATE notifications
            SET status = 'failed',
                updated_at = NOW()
            WHERE id = $1
            `,
            [job.data.notificationId]
        );
        await deadLetterEmailQueue.add(
            job.name,
            {
                ...job.data,
                originalJobId: job.id,
                failedReason,
                attemptsMade: job.attemptsMade
            },
            {
                jobId: `dlq-${job.id}`
            }
        );
        console.log(
            `[EVENT] Notification ${job.data.notificationId} permanently failed`
        );
    }
});

console.log("Email queue event listener started");