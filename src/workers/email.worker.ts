import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";

const worker = new Worker(
    "email",
    async (job) => {
        const start = Date.now();

        console.log(
            `[START] Job ${job.id} | ${new Date().toLocaleTimeString()}`
        );

        console.log(`Sending email to ${job.data.email}`);

        // Simulate email API taking 2 seconds
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const duration = Date.now() - start;

        console.log(
            `[DONE] Job ${job.id} | took ${duration}ms`
        );
    },
    {
        connection: redisConnection,
        concurrency: 1
    }
);

console.log("Email worker started");