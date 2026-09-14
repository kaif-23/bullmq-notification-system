import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { db } from "../config/database.js";
import { claimNotification } from "../services/notifications.service.js"

const worker = new Worker(
    "email",
    async (job) => {
        const start = Date.now();

        console.log(
            `[START] Job ${job.id} | ${new Date().toLocaleTimeString()}`
        );
    
        const claimed = await claimNotification(
            job.data.notificationId
        );

        if (!claimed) {
            console.log(
                `[SKIP] Notification ${job.data.notificationId} already claimed`
            );

            return;
        }
        try{
            console.log(`Sending email to ${job.data.email}`);
            if (
                job.data.shouldFail &&job.attemptsMade === 0) {
                throw new Error("Simulated temporary email failure");
            }
        // Simulate email API taking 2 seconds
        await new Promise((resolve) => setTimeout(resolve, 100));
    

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
            await db.query(
                `
        UPDATE notifications
        SET status = 'failed',
        updated_at = NOW()
        WHERE id = $1
        `,
                [job.data.notificationId]
            );

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
       
    }
);

console.log("Email worker started");