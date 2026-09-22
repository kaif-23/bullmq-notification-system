import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { db } from "../../src/config/database.js";
import { redisClient } from "../../src/config/redis-client.js";
import { emailQueue } from "../../src/queues/email.queue.js";
import { EmailProviderError } from "../../src/errors/email-provider.error.js";
import { SimulatedEmailProvider } from "../../src/providers/simulated-email.provider.js";
import { createEmailWorker } from "../../src/workers/email.worker.js";
import type { EmailProvider } from "../../src/types/email-provider.types.js";
import type { EmailJobData } from "../../src/types/email.types.js";
import { FakeEmailProvider } from "../fakes/fake-email.provider.js";
import type { Worker } from "bullmq";

const workers: Worker[] = [];

function uniqueIdempotencyKey(prefix = "worker-test") {
    return `${prefix}-${crypto.randomUUID()}`;
}

function validRequest(orderId = "worker-order") {
    return {
        email: "worker@example.com",
        type: "account-verification",
        data: { orderId }
    };
}

async function createNotification(orderId = "worker-order") {
    const response = await request(app)
        .post("/api/v1/notifications/email")
        .set("Idempotency-Key", uniqueIdempotencyKey())
        .send(validRequest(orderId));

    expect(response.status).toBe(201);
    const notificationId = response.body.notificationId as number;
    const outboxResult = await db.query<{ payload: EmailJobData }>(
        `SELECT payload FROM notification_outbox WHERE notification_id = $1`,
        [notificationId]
    );

    return { notificationId, data: outboxResult.rows[0].payload };
}

async function createWorker(provider?: EmailProvider) {
    const worker = createEmailWorker(provider);
    workers.push(worker);
    await worker.waitUntilReady();
    return worker;
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
    const result = await db.query<{
        status: string;
        attempts: number;
    }>("SELECT status, attempts FROM notifications WHERE id = $1", [notificationId]);
    return result.rows[0];
}

async function waitForJobState(jobId: string, state: string) {
    return waitFor(
        async () => {
            const job = await emailQueue.getJob(jobId);
            return job ? await job.getState() : "missing";
        },
        (currentState) => currentState === state
    );
}

describe("email worker and BullMQ retries", () => {
    beforeAll(() => {
        process.env.INTERNAL_API_KEY = "phase-4-test-internal-key";
    });

    afterEach(async () => {
        await Promise.all(workers.splice(0).map((worker) => worker.close()));
    });

    it("claims a pending notification, increments attempts, and marks it sent", async () => {
        const { notificationId, data } = await createNotification();
        const provider = new FakeEmailProvider();
        const worker = await createWorker(provider);
        const job = await emailQueue.add("account-verification", data, {
            jobId: `worker-success-${notificationId}`,
            attempts: 1
        });

        await waitForJobState(job.id!, "completed");

        expect(await getNotification(notificationId)).toEqual({
            status: "sent",
            attempts: 1
        });
        expect(provider.calls).toBe(1);
        await worker.close();
        workers.splice(workers.indexOf(worker), 1);
    });

    it("does not increment attempts when a duplicate job cannot claim a sent notification", async () => {
        const { notificationId, data } = await createNotification("duplicate-claim");
        const worker = await createWorker();
        const firstJob = await emailQueue.add("account-verification", data, {
            jobId: `worker-first-${notificationId}`,
            attempts: 1
        });
        await waitForJobState(firstJob.id!, "completed");

        const duplicateJob = await emailQueue.add("account-verification", data, {
            jobId: `worker-duplicate-${notificationId}`,
            attempts: 1
        });
        await waitForJobState(duplicateJob.id!, "completed");

        expect(await getNotification(notificationId)).toEqual({
            status: "sent",
            attempts: 1
        });
        await worker.close();
        workers.splice(workers.indexOf(worker), 1);
    });

    it("propagates provider failure and leaves the notification processing", async () => {
        const { notificationId, data } = await createNotification("provider-failure");
        const providerError = new EmailProviderError({
            code: "EMAIL_PROVIDER_UNAVAILABLE",
            message: "deterministic provider failure",
            retryable: true
        });
        const provider = new FakeEmailProvider(providerError);
        await createWorker(provider);
        const job = await emailQueue.add("account-verification", data, {
            jobId: `worker-failure-${notificationId}`,
            attempts: 1
        });

        await waitForJobState(job.id!, "failed");

        expect(await getNotification(notificationId)).toEqual({
            status: "processing",
            attempts: 1
        });
        expect((await emailQueue.getJob(job.id!))?.attemptsMade).toBe(1);
        expect((await emailQueue.getJob(job.id!))?.failedReason).toBe(
            "deterministic provider failure"
        );
    });

    it("preserves generic provider error fields", () => {
        const cause = new Error("upstream failure");
        const error = new EmailProviderError({
            code: "EMAIL_PROVIDER_UNAVAILABLE",
            message: "Email provider is unavailable",
            retryable: true,
            cause
        });

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("EmailProviderError");
        expect(error.code).toBe("EMAIL_PROVIDER_UNAVAILABLE");
        expect(error.message).toBe("Email provider is unavailable");
        expect(error.retryable).toBe(true);
        expect(error.cause).toBe(cause);
    });

    it("uses real BullMQ retry and reclaims processing on the second attempt", async () => {
        const { notificationId, data } = await createNotification("retry-success");
        const provider = new FakeEmailProvider([
            new EmailProviderError({
                code: "EMAIL_PROVIDER_TEMPORARY_FAILURE",
                message: "first attempt fails",
                retryable: true
            }),
            { status: "sent" }
        ]);
        const worker = await createWorker(provider);
        const firstFailure = new Promise<void>((resolve) => {
            worker.once("failed", () => resolve());
        });
        const job = await emailQueue.add("account-verification", data, {
            jobId: `worker-retry-${notificationId}`,
            attempts: 2,
            backoff: { type: "fixed", delay: 20 }
        });

        await firstFailure;
        expect(["delayed", "waiting"]).toContain(
            await emailQueue.getJob(job.id!).then((retryJob) => retryJob?.getState())
        );
        expect((await getNotification(notificationId)).status).toBe("processing");
        await waitForJobState(job.id!, "completed");

        expect(provider.calls).toBe(2);
        expect(await getNotification(notificationId)).toEqual({
            status: "sent",
            attempts: 2
        });
        expect((await emailQueue.getJob(job.id!))?.attemptsMade).toBe(2);
    });

    it("retries already_processing and does not mark sent before the retry succeeds", async () => {
        const { notificationId, data } = await createNotification("already-processing");
        const providerKey = `notification-${notificationId}`;
        const redisKey = `email:idempotency:${providerKey}`;
        await redisClient.set(
            redisKey,
            Date.now().toString(),
            "EX",
            3600
        );
        const worker = await createWorker();
        const firstFailure = new Promise<void>((resolve) => {
            worker.once("failed", () => resolve());
        });
        const job = await emailQueue.add("account-verification", data, {
            jobId: `worker-processing-${notificationId}`,
            attempts: 2,
            backoff: { type: "fixed", delay: 20 }
        });

        await firstFailure;

        expect((await getNotification(notificationId)).status).toBe("processing");
        await redisClient.del(redisKey);
        await waitForJobState(job.id!, "completed");

        expect(await getNotification(notificationId)).toEqual({
            status: "sent",
            attempts: 2
        });
    });

    it("treats provider already_sent as successful and marks the notification sent", async () => {
        const { notificationId, data } = await createNotification("already-sent");
        const providerKey = `notification-${notificationId}`;
        const provider = new SimulatedEmailProvider();
        expect(await provider.send({ to: data.email, idempotencyKey: providerKey })).toEqual({ status: "sent" });
        await createWorker();
        const job = await emailQueue.add("account-verification", data, {
            jobId: `worker-already-sent-${notificationId}`,
            attempts: 1
        });

        await waitForJobState(job.id!, "completed");

        expect(await getNotification(notificationId)).toEqual({
            status: "sent",
            attempts: 1
        });
    });

    it("coordinates two workers processing distinct jobs for one notification", async () => {
        const { notificationId, data } = await createNotification("concurrent-workers");
        await createWorker();
        await createWorker();
        const firstJob = await emailQueue.add("account-verification", data, {
            jobId: `worker-concurrent-a-${notificationId}`,
            attempts: 1
        });
        const secondJob = await emailQueue.add("account-verification", data, {
            jobId: `worker-concurrent-b-${notificationId}`,
            attempts: 1
        });

        await Promise.all([
            waitForJobState(firstJob.id!, "completed"),
            waitForJobState(secondJob.id!, "completed")
        ]);

        const notification = await getNotification(notificationId);
        expect(notification.status).toBe("sent");
        expect(notification.attempts).toBe(1);
        expect(await redisClient.get(`email:idempotency:notification-${notificationId}`)).toBe("sent");
    });

    it("closes a test worker without leaving an active worker connection", async () => {
        const worker = await createWorker();
        await expect(worker.close()).resolves.toBeUndefined();
        workers.splice(workers.indexOf(worker), 1);
    });
});
