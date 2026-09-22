import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import { emailQueue } from "../../src/queues/email.queue.js";
import {
    claimPendingOutboxEvents,
    recoverStuckOutboxEvents
} from "../../src/services/outbox.service.js";
import { db } from "../../src/config/database.js";
import { runRelayOnce } from "../../src/workers/outbox.relay.js";

function uniqueIdempotencyKey(prefix = "outbox-test") {
    return `${prefix}-${crypto.randomUUID()}`;
}

function validRequest(orderId = "order-123") {
    return {
        email: "test@example.com",
        type: "account-verification",
        data: { orderId }
    };
}

async function createNotification(orderId = "order-123") {
    const response = await request(app)
        .post("/api/v1/notifications/email")
        .set("Idempotency-Key", uniqueIdempotencyKey())
        .send(validRequest(orderId));

    expect(response.status).toBe(201);
    return {
        notificationId: response.body.notificationId as number,
        requestId: response.headers["x-request-id"] as string
    };
}

async function getOutboxEvent(notificationId: number) {
    const result = await db.query<{
        id: number;
        notification_id: number;
        event_type: string;
        payload: Record<string, unknown>;
        status: string;
        claimed_at: Date | null;
        published_at: Date | null;
    }>(
        `SELECT id, notification_id, event_type, payload, status, claimed_at, published_at
         FROM notification_outbox
         WHERE notification_id = $1`,
        [notificationId]
    );

    return result.rows[0];
}

describe("transactional outbox and relay", () => {
    beforeAll(() => {
        process.env.INTERNAL_API_KEY = "phase-4-test-internal-key";
    });

    it("creates one durable pending outbox event with the notification", async () => {
        const { notificationId, requestId } = await createNotification();
        const notificationResult = await db.query(
            `SELECT id, status
             FROM notifications
             WHERE id = $1`,
            [notificationId]
        );
        const event = await getOutboxEvent(notificationId);

        expect(notificationResult.rows).toEqual([
            { id: notificationId, status: "pending" }
        ]);
        expect(event).toMatchObject({
            notification_id: notificationId,
            event_type: "account-verification",
            status: "pending",
            claimed_at: null,
            published_at: null,
            payload: {
                notificationId,
                email: "test@example.com",
                type: "account-verification",
                data: { orderId: "order-123" },
                requestId
            }
        });
    });

    it("claims, publishes, and marks the event published with matching BullMQ data", async () => {
        const { notificationId, requestId } = await createNotification();
        const eventBeforeRelay = await getOutboxEvent(notificationId);

        await runRelayOnce();

        const eventAfterRelay = await getOutboxEvent(notificationId);
        const job = await emailQueue.getJob(`outbox-${eventBeforeRelay.id}`);

        expect(eventAfterRelay.status).toBe("published");
        expect(eventAfterRelay.claimed_at).toEqual(expect.any(Date));
        expect(eventAfterRelay.published_at).toEqual(expect.any(Date));
        expect(job).toBeDefined();
        expect(job?.id).toBe(`outbox-${eventBeforeRelay.id}`);
        expect(job?.data).toEqual({
            notificationId,
            email: "test@example.com",
            type: "account-verification",
            data: { orderId: "order-123" },
            requestId
        });
    });

    it("uses the deterministic job ID when the same event is retried", async () => {
        const { notificationId } = await createNotification();
        const event = await getOutboxEvent(notificationId);
        const jobId = `outbox-${event.id}`;

        await runRelayOnce();
        await db.query(
            `UPDATE notification_outbox
             SET status = 'pending', claimed_at = NULL
             WHERE id = $1`,
            [event.id]
        );
        await runRelayOnce();

        const job = await emailQueue.getJob(jobId);
        const matchingJobs = (await emailQueue.getJobs([
            "waiting",
            "active",
            "completed",
            "failed",
            "delayed"
        ])).filter((candidate) => candidate.id === jobId);

        expect(job?.id).toBe(jobId);
        expect(matchingJobs).toHaveLength(1);
        expect((await getOutboxEvent(notificationId)).status).toBe("published");
    });

    it("claims concurrent relay batches without overlapping events", async () => {
        const created = await Promise.all(
            Array.from({ length: 20 }, (_, index) =>
                createNotification(`concurrent-order-${index}`)
            )
        );
        const expectedNotificationIds = created.map((item) => item.notificationId);

        const [claimedByRelayA, claimedByRelayB] = await Promise.all([
            claimPendingOutboxEvents(),
            claimPendingOutboxEvents()
        ]);
        const claimedIds = [
            ...claimedByRelayA.map((event) => event.id),
            ...claimedByRelayB.map((event) => event.id)
        ];
        const expectedEvents = await db.query<{ id: number; notification_id: number }>(
            `SELECT id, notification_id
             FROM notification_outbox
             WHERE notification_id = ANY($1::int[])
             ORDER BY id`,
            [expectedNotificationIds]
        );

        expect(claimedByRelayA.length).toBe(10);
        expect(claimedByRelayB.length).toBe(10);
        expect(new Set(claimedIds).size).toBe(20);
        expect(new Set(claimedIds)).toEqual(
            new Set(expectedEvents.rows.map((event) => event.id))
        );

        await db.query(
            `UPDATE notification_outbox
             SET status = 'pending', claimed_at = NULL
             WHERE id = ANY($1::int[])`,
            [claimedIds]
        );
        await Promise.all([runRelayOnce(), runRelayOnce()]);

        const statuses = await db.query<{ status: string; count: number }>(
            `SELECT status, COUNT(*)::int AS count
             FROM notification_outbox
             WHERE notification_id = ANY($1::int[])
             GROUP BY status`,
            [expectedNotificationIds]
        );
        expect(statuses.rows).toEqual([{ status: "published", count: 20 }]);
    });

    it("recovers stale publishing events but not recent ones", async () => {
        const stale = await createNotification("stale-order");
        const recent = await createNotification("recent-order");
        const staleEvent = await getOutboxEvent(stale.notificationId);
        const recentEvent = await getOutboxEvent(recent.notificationId);

        await db.query(
            `UPDATE notification_outbox
             SET status = 'publishing', claimed_at = NOW() - INTERVAL '6 minutes'
             WHERE id = $1`,
            [staleEvent.id]
        );
        await db.query(
            `UPDATE notification_outbox
             SET status = 'publishing', claimed_at = NOW()
             WHERE id = $1`,
            [recentEvent.id]
        );

        const recovered = await recoverStuckOutboxEvents();
        const staleAfterRecovery = await getOutboxEvent(stale.notificationId);
        const recentAfterRecovery = await getOutboxEvent(recent.notificationId);

        expect(recovered.map((event) => event.id)).toEqual([staleEvent.id]);
        expect(staleAfterRecovery).toMatchObject({ status: "pending", claimed_at: null });
        expect(recentAfterRecovery.status).toBe("publishing");
        expect(recentAfterRecovery.claimed_at).toEqual(expect.any(Date));

        await runRelayOnce();
        expect((await getOutboxEvent(stale.notificationId)).status).toBe("published");
        expect((await getOutboxEvent(recent.notificationId)).status).toBe("publishing");
    });

    it("recovers an event after a publish failure and publishes it later", async () => {
        const { notificationId } = await createNotification("failure-order");
        const event = await getOutboxEvent(notificationId);
        const addSpy = vi
            .spyOn(emailQueue, "add")
            .mockRejectedValueOnce(new Error("simulated publish failure"));

        await runRelayOnce();
        addSpy.mockRestore();

        const failedPublishState = await getOutboxEvent(notificationId);
        expect(failedPublishState.status).toBe("publishing");
        expect(failedPublishState.claimed_at).toEqual(expect.any(Date));

        await db.query(
            `UPDATE notification_outbox
             SET claimed_at = NOW() - INTERVAL '6 minutes'
             WHERE id = $1`,
            [event.id]
        );
        await recoverStuckOutboxEvents();
        expect((await getOutboxEvent(notificationId)).status).toBe("pending");

        await runRelayOnce();
        expect((await getOutboxEvent(notificationId)).status).toBe("published");
        expect(await emailQueue.getJob(`outbox-${event.id}`)).toBeDefined();
    });
});
