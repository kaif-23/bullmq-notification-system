import { Worker } from "bullmq";
import { redisConnection } from "../config/redis";

const worker = new Worker(
    "email",
    async (job) => {
        console.log("-----------------------------");
        console.log("Processing job:", job.id);
        console.log("Job name:", job.name);
        console.log("Attempt:", job.attemptsMade + 1);
        console.log("Job data:", job.data);

        if (
            job.data.simulateTransientFailure &&
            job.attemptsMade < 2
        ) {
            console.log("Simulating temporary failure...");

            throw new Error("Email provider temporarily unavailable");
        }

        console.log(`Sending email to ${job.data.email}`);

        await new Promise((resolve) => setTimeout(resolve, 2000));

        console.log("Email sent successfully");
        console.log("-----------------------------");
    },
    {
        connection: redisConnection
    }
);

console.log("Email worker started");