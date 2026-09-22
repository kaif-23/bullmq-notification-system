import { emailQueue } from "../queues/email.queue.js";
import { claimPendingOutboxEvents, markOutboxPublished, recoverStuckOutboxEvents } from "../services/outbox.service.js";
import { db } from "../config/database.js";

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

                console.log(
                    `[OUTBOX] Published event ${event.id}`
                );
            } catch (error) {
                console.error(
                    `[OUTBOX] Failed to publish event ${event.id}`,
                    error
                );
            }
        }

        await recoverStuckOutboxEvents();
    } catch (error) {
        console.error("[OUTBOX] Relay cycle failed", error);
    }
}

export async function startRelay() {
    console.log("[OUTBOX] Relay started");

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
    console.log(`[OUTBOX] Received ${signal} — shutting down gracefully...`);
    await currentCycle;
    await emailQueue.close();
    await db.end();
    console.log("[OUTBOX] Relay shut down cleanly");
    process.exit(0);
}