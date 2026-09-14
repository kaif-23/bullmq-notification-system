import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { db } from "../config/database.js";
import { claimNotification, incrementNotificationAttempts } from "../services/notifications.service.js"
import { sendEmail } from "../services/email.service.js";

const worker = new Worker(
    "email",
    async (job) => {
        const start = Date.now();

        console.log(
            `[START] Job ${job.id} | ${new Date().toLocaleTimeString()}`
        );
    
        const claimed = await claimNotification(
            job.data.notificationId,
            job.attemptsMade > 0
        );

        if (!claimed) {
            console.log(
                `[SKIP] Notification ${job.data.notificationId} already claimed`
            );

            return;
        }
        await incrementNotificationAttempts(
            job.data.notificationId
        );
        try{
            console.log(`Sending email to ${job.data.email}`);

            if (
                job.data.shouldFail &&
                job.attemptsMade === 0
            ) {
                throw new Error("Simulated temporary email failure");
            }

            await sendEmail(job.data.email);

        await db.query(
            `
        UPDATE notifications
        SET status = 'sent',
        updated_at = NOW()
        WHERE id = $1
    `,
            [job.data.notificationId]
        );

        } catch (error) {
            console.error(
                `[FAILED] Job ${job.id}`,
                error
            );

            throw error;
        }

     const duration = Date.now() - start;

        console.log(
            `[DONE] Job ${job.id} | took ${duration}ms`
        );
    },
    {
        connection: redisConnection,
        concurrency: 2,
        limiter: {
            max: 2,
            duration: 1000
        }
       
    }
);

console.log("Email worker started");
process.on("SIGTERM", async () => {
    console.log("Shutting down worker...");

    await worker.close();

    console.log("Worker shut down");
    process.exit(0);
});

process.on("SIGINT", async () => {
    console.log("Shutting down worker...");

    await worker.close();

    console.log("Worker shut down");
    process.exit(0);
});