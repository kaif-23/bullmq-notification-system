import { redisClient } from "../config/redis-client.js";
import { db } from "../config/database.js";
import { createEmailWorker } from "./email.worker.js";

const worker = createEmailWorker();

console.log("[WORKER] Email worker started");

async function shutdown(signal: string) {
    console.log(`[WORKER] Received ${signal} — shutting down gracefully...`);
    await worker.close();
    await redisClient.quit();
    await db.end();
    console.log("[WORKER] Worker shut down cleanly");
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));