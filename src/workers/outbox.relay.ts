import { emailQueue } from "../queues/email.queue.js";
import { claimPendingOutboxEvents, markOutboxPublished, recoverStuckOutboxEvents } from "../services/outbox.service.js";
import { db } from "../config/database.js";
import { logError, logInfo, safeErrorContext } from "../utils/logger.js";

let running = true;
let timer: NodeJS.Timeout | undefined;
let currentCycle = Promise.resolve();

export async function runRelayOnce(): Promise<void> {
    try {
        const events = await claimPendingOutboxEvents();

        for (const event of events) {
            try {
                await emailQueue.add(
                    event.event_type,
                    event.payload,
                    {
                        jobId: `outbox-${event.id}`,
                        attempts: 3,
                        backoff: {
                            type: "exponential",
                            delay: 2000
                        },
                        removeOnComplete: {
                            age: 3600,
                            count: 1000
                        },
                        removeOnFail: {
                            age: 86400,
                            count: 5000
                        }
                    }
                );

                await markOutboxPublished(event.id);

                logInfo("outbox_event_published", {
                    outboxEventId: event.id,
                    notificationId: event.notification_id,
                    jobId: `outbox-${event.id}`
                });
            } catch (error) {
                logError("outbox_event_publish_failed", {
                    outboxEventId: event.id,
                    notificationId: event.notification_id,
                    requestId: typeof event.payload.requestId === "string"
                        ? event.payload.requestId
                        : null,
                    ...safeErrorContext(error)
                });
            }
        }

        await recoverStuckOutboxEvents();
    } catch (error) {
        logError("outbox_relay_cycle_failed", {
            ...safeErrorContext(error)
        });
    }
}

export async function startRelay() {
    logInfo("outbox_relay_started");

    while (running) {
        currentCycle = runRelayOnce();
        await currentCycle;
        if (!running) break;
        await new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5000);
        });
    }
}

export async function shutdown(signal: string) {
    running = false;
    if (timer) clearTimeout(timer);
    logInfo("outbox_relay_shutdown_started", { signal });
    await currentCycle;
    await emailQueue.close();
    await db.end();
    logInfo("outbox_relay_shutdown_completed");
    process.exit(0);
}