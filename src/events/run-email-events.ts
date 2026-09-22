import { db } from "../config/database.js";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
import { emailQueue } from "../queues/email.queue.js";
import {
    createEmailQueueEvents,
    reconcileExhaustedJobs,
    RECONCILIATION_INTERVAL_MS
} from "./email.events.js";

const emailQueueEvents = createEmailQueueEvents();
const reconciliationTimer = setInterval(() => {
    void reconcileExhaustedJobs().catch((error) => {
        console.error("[DLQ] Reconciliation failed", error);
    });
}, RECONCILIATION_INTERVAL_MS);

console.log("[EVENT] Email queue event listener started");

let shuttingDown = false;

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconciliationTimer);
    console.log(`[EVENT] Received ${signal} — shutting down gracefully...`);
    await emailQueueEvents.close();
    await emailQueue.close();
    await deadLetterEmailQueue.close();
    await db.end();
    console.log("[EVENT] Event listener shut down cleanly");
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
