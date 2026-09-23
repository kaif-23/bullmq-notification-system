import { db } from "../config/database.js";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
import { emailQueue } from "../queues/email.queue.js";
import {
    createEmailQueueEvents,
    reconcileExhaustedJobs,
    RECONCILIATION_INTERVAL_MS
} from "./email.events.js";
import { logError, logInfo, safeErrorContext } from "../utils/logger.js";

const emailQueueEvents = createEmailQueueEvents();
const reconciliationTimer = setInterval(() => {
    void reconcileExhaustedJobs().catch((error) => {
        logError("dlq_reconciliation_failed", safeErrorContext(error));
    });
}, RECONCILIATION_INTERVAL_MS);

logInfo("email_queue_events_started");

let shuttingDown = false;

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconciliationTimer);
    logInfo("email_queue_events_shutdown_started", { signal });
    await emailQueueEvents.close();
    await emailQueue.close();
    await deadLetterEmailQueue.close();
    await db.end();
    logInfo("email_queue_events_shutdown_completed");
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
