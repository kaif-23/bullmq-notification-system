import { emailQueue } from "../queues/email.queue.js";
import { claimPendingOutboxEvents, getPendingOutboxEvents, markOutboxPublished, recoverStuckOutboxEvents } from "../services/outbox.service.js";

async function publishOutboxEvents() {
    const events = await getPendingOutboxEvents();

    for (const event of events) {
        await emailQueue.add(
            event.event_type,
            event.payload,
            {
                jobId: `outbox-${event.id}`
            }
        );
        await markOutboxPublished(event.id);
        console.log(
            `[OUTBOX] Published event ${event.id} → Job outbox-${event.id}`
        );
    }
}

async function startRelay() {
    console.log("[OUTBOX] Relay started");

    while (true) {
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

        await new Promise((resolve) =>
            setTimeout(resolve, 5000)
        );
    }
}

startRelay();