import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { emailProvider } from "../providers/simulated-email.provider.js";
import type { EmailProvider } from "../types/email-provider.types.js";
import { processEmailJob } from "./email.processor.js";

export function createEmailWorker(
    provider: EmailProvider = emailProvider
): Worker {
    return new Worker(
        "email",
        (job) => processEmailJob(job, provider),
        {
            connection: redisConnection,
            concurrency: 2,
            limiter: {
                max: 2,
                duration: 1000
            }
        }
    );
}
