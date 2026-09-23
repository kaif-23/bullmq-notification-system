import { redisClient } from "../config/redis-client.js";
import { db } from "../config/database.js";
import { ResendEmailProvider } from "../providers/resend-email.provider.js";
import { createEmailWorker } from "./email.worker.js";
import { logInfo } from "../utils/logger.js";

const worker = createEmailWorker(new ResendEmailProvider());

logInfo("email_worker_started");

async function shutdown(signal: string) {
    logInfo("email_worker_shutdown_started", { signal });
    await worker.close();
    await redisClient.quit();
    await db.end();
    logInfo("email_worker_shutdown_completed");
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));