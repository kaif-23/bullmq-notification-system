import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job, QueueEvents, Worker } from "bullmq";
import app from "../../src/app.js";
import { db } from "../../src/config/database.js";
import { EmailProviderError } from "../../src/errors/email-provider.error.js";
import { createEmailQueueEvents, reconcileExhaustedJobs } from "../../src/events/email.events.js";
import { deadLetterEmailQueue } from "../../src/queues/dead-letter-email.queue.js";
import { emailQueue } from "../../src/queues/email.queue.js";
import { claimNotification } from "../../src/services/notifications.service.js";
import { replayDlqJob, MAX_REPLAYS } from "../../src/services/dlq.service.js";
import { runRelayOnce } from "../../src/workers/outbox.relay.js";
import { createEmailWorker } from "../../src/workers/email.worker.js";
import type { EmailJobData } from "../../src/types/email.types.js";
import { FakeEmailProvider } from "../fakes/fake-email.provider.js";
import { SimulatedEmailProvider } from "../../src/providers/simulated-email.provider.js";

const internalApiKey = "phase-4-test-internal-key";
const workers: Worker[] = [];
const queueEvents: QueueEvents[] = [];

function uniqueIdempotencyKey(prefix = "dlq-test") {
    return `${prefix}-${crypto.randomUUID()}`;
}

function validRequest(orderId = "dlq-order") {
    return {
        email: "dlq@example.com",
        type: "account-verification",
        data: { orderId }
    };
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
    const deadline = Date.now() + 8_000;
    let value = await read();
    while (!predicate(value) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        value = await read();
    }
    expect(predicate(value)).toBe(true);
    return value;
}

async function getNotification(notificationId: number) {
    const result = await db.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM notifications WHERE id = $1",
        [notificationId]
    );
    return result.rows[0];
}

async function createNotification(orderId: string) {
    const response = await request(app)
        .post("/api/v1/notifications/email")
        .set("Idempotency-Key", uniqueIdempotencyKey())
        .send(validRequest(orderId));
    expect(response.status).toBe(201);

    const notificationId = response.body.notificationId as number;
    const outboxResult = await db.query<{ payload: EmailJobData }>(
        "SELECT payload FROM notification_outbox WHERE notification_id = $1",
        [notificationId]
    );

    return { notificationId, data: outboxResult.rows[0].payload };
}

async function createFailedNotification(
    orderId: string,
    useEvents = true,
    attempts = 1
) {
    const created = await createNotification(orderId);
    await db.query(
        `UPDATE notification_outbox
         SET status = 'published', published_at = NOW()
         WHERE notification_id = $1`,
        [created.notificationId]
    );

    const provider = new FakeEmailProvider(new EmailProviderError({
        code: "EMAIL_PROVIDER_INVALID_REQUEST",
        message: "permanent provider failure",
        retryable: false
    }));
    const worker = createEmailWorker(provider);
    workers.push(worker);
    await worker.waitUntilReady();

    let events: QueueEvents | undefined;
    if (useEvents) {
        events = createEmailQueueEvents();
        queueEvents.push(events);
        await events.waitUntilReady();
    }

    const originalJob = await emailQueue.add("account-verification", created.data, {
        jobId: `dlq-source-${created.notificationId}`,
        attempts,
        removeOnFail: { age: 3600, count: 100 }
    });

    await waitFor(
        async () => (await emailQueue.getJob(originalJob.id!))?.getState() ?? "missing",
        (state) => state === "failed"
    );
    await waitFor(
        () => getNotification(created.notificationId),
        (notification) => notification.status === (useEvents ? "failed" : "processing")
    );

    if (events) {
        await waitFor(
            () => deadLetterEmailQueue.getJob(`dlq-${originalJob.id!}`),
            (job) => job !== undefined && job !== null
        );
    }

    await worker.close();
    workers.splice(workers.indexOf(worker), 1);
    if (events) {
        await events.close();
        queueEvents.splice(queueEvents.indexOf(events), 1);
    }

    return {
        ...created,
        originalJobId: originalJob.id!,
        dlqJobId: `dlq-${originalJob.id!}`
    };
}

async function createManualDlqJob(
    notificationId: number,
    data: EmailJobData,
    replayCount = 0,
    jobId = `dlq-manual-${notificationId}`
) {
    return deadLetterEmailQueue.add(
        "account-verification",
        {
            ...data,
            originalJobId: `manual-source-${notificationId}`,
            failedReason: "manual retained failure",
            attemptsMade: 1,
            replayCount
        },
        { jobId }
    );
}

describe("DLQ, reconciliation, and replay", () => {
    beforeAll(() => {
        process.env.INTERNAL_API_KEY = internalApiKey;
    });

    afterEach(async () => {
        await Promise.all(workers.splice(0).map((worker) => worker.close()));
        await Promise.all(queueEvents.splice(0).map((events) => events.close()));
    });

    it("moves permanent worker failure to failed and creates one deterministic DLQ job", async () => {
        const failed = await createFailedNotification("permanent-failure");
        const dlqJob = await deadLetterEmailQueue.getJob(failed.dlqJobId);

        expect(await getNotification(failed.notificationId)).toEqual({
            status: "failed",
            attempts: 1
        });
        expect(dlqJob).toBeDefined();
        expect(dlqJob?.id).toBe(failed.dlqJobId);
        expect(dlqJob?.data).toMatchObject({
            originalJobId: failed.originalJobId,
            notificationId: failed.notificationId,
            attemptsMade: 1,
            replayCount: 0,
            failureCode: "EMAIL_PROVIDER_INVALID_REQUEST",
            failedReason: "permanent provider failure"
        });
        expect(
            (await deadLetterEmailQueue.getJobs(["waiting", "active", "completed", "failed", "delayed"]))
                .filter((job) => job.id === failed.dlqJobId)
        ).toHaveLength(1);
    });

    it("fails a permanent provider error without consuming remaining BullMQ retries", async () => {
        const failed = await createFailedNotification("permanent-before-exhaustion", true, 3);
        const originalJob = await emailQueue.getJob(failed.originalJobId);
        const dlqJob = await deadLetterEmailQueue.getJob(failed.dlqJobId);

        expect(await originalJob?.getState()).toBe("failed");
        expect(originalJob?.attemptsMade).toBe(1);
        expect(originalJob?.opts.attempts).toBe(3);
        expect(dlqJob?.data.failureCode).toBe("EMAIL_PROVIDER_INVALID_REQUEST");
        expect(await getNotification(failed.notificationId)).toEqual({
            status: "failed",
            attempts: 1
        });
    });

    it("prevents duplicate DLQ entries when permanent handling runs twice", async () => {
        const failed = await createFailedNotification("duplicate-dlq");
        const originalJob = await emailQueue.getJob(failed.originalJobId);
        expect(originalJob).toBeDefined();

        const { ensureDlqEntry } = await import("../../src/events/email.events.js");
        await ensureDlqEntry(originalJob!, "permanent provider failure");
        await ensureDlqEntry(originalJob!, "permanent provider failure");

        const dlqJobs = (await deadLetterEmailQueue.getJobs([
            "waiting",
            "active",
            "completed",
            "failed",
            "delayed"
        ])).filter((job) => job.id === failed.dlqJobId);
        expect(dlqJobs).toHaveLength(1);
        expect((await getNotification(failed.notificationId)).status).toBe("failed");
    });

    it("reconciliation detects a retained failed job without QueueEvents", async () => {
        const failed = await createFailedNotification("reconciliation", false);

        await reconcileExhaustedJobs();

        expect((await getNotification(failed.notificationId)).status).toBe("failed");
        expect(await deadLetterEmailQueue.getJob(failed.dlqJobId)).toBeDefined();
    });

    it("is safe to run reconciliation repeatedly", async () => {
        const failed = await createFailedNotification("reconciliation-repeat", false);

        await reconcileExhaustedJobs();
        await reconcileExhaustedJobs();

        expect((await getNotification(failed.notificationId)).status).toBe("failed");
        expect(
            (await deadLetterEmailQueue.getJobs(["waiting", "active", "completed", "failed", "delayed"]))
                .filter((job) => job.id === failed.dlqJobId)
        ).toHaveLength(1);
    });

    it("retrieves a DLQ job and returns 404 for an unknown ID", async () => {
        const failed = await createFailedNotification("dlq-lookup");
        const response = await request(app)
            .get(`/internal/dlq/${failed.dlqJobId}`)
            .set("X-Internal-Api-Key", internalApiKey);
        const missingResponse = await request(app)
            .get("/internal/dlq/unknown-dlq-job")
            .set("X-Internal-Api-Key", internalApiKey);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            id: failed.dlqJobId,
            originalJobId: failed.originalJobId,
            notificationId: failed.notificationId,
            replayCount: 0,
            maxReplays: MAX_REPLAYS,
            canReplay: true
        });
        expect(missingResponse.status).toBe(404);
        expect(missingResponse.body).toEqual({ message: "DLQ job not found" });
    });

    it("replays through failed to pending, creates an outbox event, relays it, and sends it", async () => {
        const failed = await createFailedNotification("replay-success");
        const before = await db.query<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM notification_outbox WHERE notification_id = $1",
            [failed.notificationId]
        );
        const replayResponse = await request(app)
            .post(`/internal/dlq/${failed.dlqJobId}/retry`)
            .set("X-Internal-Api-Key", internalApiKey);

        expect(replayResponse.status).toBe(202);
        expect(replayResponse.body.replayCount).toBe(1);
        expect((await getNotification(failed.notificationId)).status).toBe("pending");

        const replayEvent = await db.query<{
            id: number;
            status: string;
            payload: EmailJobData;
        }>(
            `SELECT id, status, payload
             FROM notification_outbox
             WHERE notification_id = $1
             ORDER BY id DESC
             LIMIT 1`,
            [failed.notificationId]
        );
        expect(before.rows[0].count).toBe(1);
        expect(replayEvent.rows[0]).toMatchObject({
            status: "pending",
            payload: {
                notificationId: failed.notificationId,
                email: "dlq@example.com",
                type: "account-verification",
                replayCount: 1
            }
        });

        await runRelayOnce();
        const replayJobId = `outbox-${replayEvent.rows[0].id}`;
        expect(await emailQueue.getJob(replayJobId)).toBeDefined();

        const worker = createEmailWorker(new SimulatedEmailProvider());
        workers.push(worker);
        await worker.waitUntilReady();
        await waitFor(
            async () => (await emailQueue.getJob(replayJobId))?.getState() ?? "missing",
            (state) => state === "completed"
        );
        expect(await getNotification(failed.notificationId)).toMatchObject({
            status: "sent",
            attempts: 2
        });
    });

    it("does not duplicate replay work if DLQ removal fails after commit", async () => {
        const failed = await createFailedNotification("replay-remove-failure");
        const dlqJob = await deadLetterEmailQueue.getJob(failed.dlqJobId);
        expect(dlqJob).toBeDefined();
        const getJobSpy = vi
            .spyOn(deadLetterEmailQueue, "getJob")
            .mockResolvedValue(dlqJob as Job<EmailJobData>);
        const removeSpy = vi
            .spyOn(dlqJob!, "remove")
            .mockRejectedValue(new Error("simulated Redis removal failure"));

        const first = await replayDlqJob(failed.dlqJobId);
        const countAfterFirst = await db.query<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM notification_outbox WHERE notification_id = $1",
            [failed.notificationId]
        );
        const second = await replayDlqJob(failed.dlqJobId);

        expect("outboxEventId" in first).toBe(true);
        expect(second).toMatchObject({
            code: "NOTIFICATION_NOT_REPLAYABLE",
            notificationId: failed.notificationId
        });
        expect(countAfterFirst.rows[0].count).toBe(2);
        expect(removeSpy).toHaveBeenCalledTimes(1);
        getJobSpy.mockRestore();
        removeSpy.mockRestore();
    });

    it.each(["pending", "processing", "sent"] as const)(
        "rejects replay for a %s notification without creating an event",
        async (status) => {
            const created = await createNotification(`not-replayable-${status}`);
            const dlqJob = await createManualDlqJob(created.notificationId, created.data);
            if (status === "processing") {
                expect(await claimNotification(created.notificationId, false)).toBe(true);
            } else if (status === "sent") {
                await db.query(
                    "UPDATE notifications SET status = 'sent' WHERE id = $1",
                    [created.notificationId]
                );
            }

            const response = await request(app)
                .post(`/internal/dlq/${dlqJob.id}/retry`)
                .set("X-Internal-Api-Key", internalApiKey);
            const count = await db.query<{ count: number }>(
                "SELECT COUNT(*)::int AS count FROM notification_outbox WHERE notification_id = $1",
                [created.notificationId]
            );

            expect(response.status).toBe(409);
            expect(response.body.error).toBe(
                status === "sent"
                    ? "NOTIFICATION_ALREADY_SENT"
                    : "NOTIFICATION_NOT_REPLAYABLE"
            );
            expect(count.rows[0].count).toBe(1);
        }
    );

    it("rejects replay at the configured maximum without creating an event", async () => {
        const created = await createNotification("replay-maximum");
        const dlqJob = await createManualDlqJob(
            created.notificationId,
            created.data,
            MAX_REPLAYS
        );
        const response = await request(app)
            .post(`/internal/dlq/${dlqJob.id}/retry`)
            .set("X-Internal-Api-Key", internalApiKey);
        const count = await db.query<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM notification_outbox WHERE notification_id = $1",
            [created.notificationId]
        );

        expect(response.status).toBe(409);
        expect(response.body.error).toBe("MAX_REPLAYS_EXCEEDED");
        expect(count.rows[0].count).toBe(1);
    });

    it("allows only one concurrent replay transaction", async () => {
        const failed = await createFailedNotification("concurrent-replay");
        const dlqJob = await deadLetterEmailQueue.getJob(failed.dlqJobId);
        const getJobSpy = vi
            .spyOn(deadLetterEmailQueue, "getJob")
            .mockResolvedValue(dlqJob as Job<EmailJobData>);
        vi.spyOn(dlqJob!, "remove").mockResolvedValue(undefined);

        const results = await Promise.all([
            replayDlqJob(failed.dlqJobId),
            replayDlqJob(failed.dlqJobId)
        ]);
        const count = await db.query<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM notification_outbox WHERE notification_id = $1",
            [failed.notificationId]
        );

        expect(results.filter((result) => "outboxEventId" in result)).toHaveLength(1);
        expect(results.filter((result) => "code" in result)).toHaveLength(1);
        expect(count.rows[0].count).toBe(2);
        expect((await getNotification(failed.notificationId)).status).toBe("pending");
        getJobSpy.mockRestore();
    });
});
