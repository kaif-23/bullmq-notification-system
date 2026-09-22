import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { sendEmail } from "../services/email.service.js";
import { processEmailJob, type SendEmailImplementation } from "./email.processor.js";

export function createEmailWorker(
    sendEmailImplementation: SendEmailImplementation = sendEmail
): Worker {
    return new Worker(
        "email",
        (job) => processEmailJob(job, sendEmailImplementation),
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
