import { Request, Response } from "express";
import { emailQueue } from "../queues/email.queue.js";
import { db } from "../config/database.js";
import {
    createNotification,
    createNotificationWithOutbox
} from "../services/notifications.service.js";
import {
    getPendingOutboxEvents,
    claimPendingOutboxEvents,
    recoverStuckOutboxEvents
} from "../services/outbox.service.js";

export const testRoot = async (req: Request, res: Response) => {
    const job = await emailQueue.add(
        "welcome-email",
        {
            email: "user@gmail.com",
            name: "Kaif",
            simulateTransientFailure: true
        },
        {
            attempts: 3,
            backoff: {
                type: "fixed",
                delay: 2000
            }
        }
    );

    res.json({
        message: "Email job added to the queue",
        jobId: job.id
    });
};

export const testBulk = async (req: Request, res: Response) => {
    const start = Date.now();
    const jobs = [];

    for (let i = 1; i <= 10; i++) {
        const job = await emailQueue.add("welcome-email", {
            email: `user${i}@gmail.com`,
            name: `User ${i}`
        });

        jobs.push(job.id);
    }

    res.json({
        message: "10 jobs added",
        duration: `${Date.now() - start}ms`,
        jobIds: jobs
    });
};

export const testDelayed = async (req: Request, res: Response) => {
    const job = await emailQueue.add(
        "verification-reminder",
        { email: "user@gmail.com" },
        { delay: 10000 }
    );

    res.json({
        message: "Delayed email job added",
        jobId: job.id
    });
};

export const testFailureEvent = async (req: Request, res: Response) => {
    const idempotencyKey = `dlq-test-${Date.now()}`;
    const notification = await createNotification(
        idempotencyKey,
        "failure@gmail.com",
        "test-failure"
    );

    const job = await emailQueue.add(
        "test-failure",
        {
            notificationId: notification.id,
            email: notification.email,
            shouldFail: true
        },
        {
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 }
        }
    );

    res.json({
        message: "DLQ test job added",
        notificationId: notification.id,
        jobId: job.id
    });
};

export const testPriority = async (req: Request, res: Response) => {
    await emailQueue.add("marketing-email", { email: "marketing@gmail.com" }, { priority: 10 });
    await emailQueue.add("welcome-email", { email: "welcome@gmail.com" }, { priority: 5 });
    await emailQueue.add("password-reset", { email: "security@gmail.com" }, { priority: 1 });

    res.json({ message: "Priority test jobs added" });
};

export const testDuplicate = async (req: Request, res: Response) => {
    const jobId = "verification-user-999";
    const job1 = await emailQueue.add("verification-email", { email: "user@gmail.com" }, { jobId });
    const job2 = await emailQueue.add("verification-email", { email: "user@gmail.com" }, { jobId });

    console.log("Job 1 ID:", job1.id);
    console.log("Job 2 ID:", job2.id);
    console.log("Job 1 state:", await job1.getState());
    console.log("Job 2 state:", await job2.getState());

    res.json({
        firstJobId: job1.id,
        secondJobId: job2.id,
        sameObject: job1 === job2
    });
};

export const testIdempotency = async (req: Request, res: Response) => {
    const idempotencyKey = "notification-user-123";
    await emailQueue.add("verification-email", { email: "user@gmail.com", idempotencyKey });
    await emailQueue.add("verification-email", { email: "user@gmail.com", idempotencyKey });

    res.json({ message: "Two jobs added" });
};

export const testDb = async (req: Request, res: Response) => {
    const notification = await createNotification(
        "notification-user-123",
        "user@gmail.com",
        "verification-email"
    );
    res.json(notification);
};

export const testDbFailure = async (req: Request, res: Response) => {
    const idempotencyKey = "notification-retry-success-001";
    const notification = await createNotification(
        idempotencyKey,
        "failure@gmail.com",
        "verification-email"
    );

    const job = await emailQueue.add(
        "verification-email",
        {
            notificationId: notification.id,
            email: notification.email,
            idempotencyKey: notification.idempotency_key,
            shouldFail: true
        },
        {
            jobId: idempotencyKey,
            attempts: 3,
            backoff: { type: "fixed", delay: 2000 }
        }
    );

    res.json({
        message: "Failure test queued",
        notificationId: notification.id,
        jobId: job.id
    });
};

export const testRateLimit = async (req: Request, res: Response) => {
    for (let i = 1; i <= 6; i++) {
        const idempotencyKey = `rate-limit-${Date.now()}-${i}`;
        const { notification } = await createNotificationWithOutbox(
            idempotencyKey,
            `rate-${i}@gmail.com`,
            "verification-email"
        );
        await emailQueue.add(
            "verification-email",
            { notificationId: notification.id, email: notification.email },
            { attempts: 1 }
        );
    }
    res.json({ message: "6 jobs created" });
};

export const testConcurrentClaim = async (req: Request, res: Response) => {
    const idempotencyKey = "notification-concurrent-002";
    const notification = await createNotification(
        idempotencyKey,
        "concurrent@gmail.com",
        "verification-email"
    );

    await emailQueue.add("verification-email", { notificationId: notification.id, email: notification.email });
    await emailQueue.add("verification-email", { notificationId: notification.id, email: notification.email });

    res.json({
        message: "Two jobs created for one notification",
        notificationId: notification.id
    });
};

export const testTransactionRollback = async (req: Request, res: Response) => {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `INSERT INTO notifications (idempotency_key, email, type) VALUES ($1, $2, $3) RETURNING id`,
            ["transaction-test-001", "transaction@gmail.com", "test-email"]
        );

        const notificationId = result.rows[0].id;
        console.log("Notification inserted:", notificationId);

        // Intentionally invalid notification ID
        await client.query(
            `INSERT INTO notification_outbox (notification_id, event_type, payload) VALUES ($1, $2, $3)`,
            [999999, "test-email", JSON.stringify({ email: "transaction@gmail.com" })]
        );

        await client.query("COMMIT");
        res.json({ message: "Transaction committed" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Transaction rolled back:", error);
        throw error;
    } finally {
        client.release();
    }
};

export const testOutbox = async (req: Request, res: Response) => {
    const events = await getPendingOutboxEvents();
    res.json({ count: events.length, events });
};

export const testOutboxClaim = async (req: Request, res: Response) => {
    const events = await claimPendingOutboxEvents();
    res.json({ count: events.length, events });
};

export const testOutboxRecovery = async (req: Request, res: Response) => {
    const recovered = await recoverStuckOutboxEvents();
    res.json({ count: recovered.length, recovered });
};
