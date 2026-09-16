import express from 'express';
import { emailQueue } from './queues/email.queue.js';
import { db } from "./config/database.js";
import { createNotification, claimNotification, createNotificationWithOutbox,retryFailedNotification } from "./services/notifications.service.js";
import { getPendingOutboxEvents, claimPendingOutboxEvents, recoverStuckOutboxEvents } from "./services/outbox.service.js";
import { deadLetterEmailQueue } from "./queues/dead-letter-email.queue.js";
const app = express();

const PORT = 3000;

app.get('/', async (req, res) => {

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
    })
});


app.get("/dlq", async (req, res) => {
    try {
        const jobs = await deadLetterEmailQueue.getJobs(
            ["waiting", "active", "completed", "failed", "delayed"],
            0,
            20
        );

        res.json(
            jobs.map((job) => ({
                id: job.id,
                name: job.name,
                data: job.data,
                attemptsMade: job.attemptsMade,
                failedReason: job.data.failedReason
            }))
        );
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to get DLQ jobs"
        });
    }
});
app.post("/dlq/:jobId/retry", async (req, res) => {
    try {
        const dlqJob = await deadLetterEmailQueue.getJob(
            req.params.jobId
        );

        if (!dlqJob) {
            return res.status(404).json({
                message: "DLQ job not found"
            });
        }
        const notificationReset = await retryFailedNotification(
            dlqJob.data.notificationId
        );

        if (!notificationReset) {
            return res.status(409).json({
                message: "Notification cannot be replayed"
            });
        }
        const newJob = await emailQueue.add(
            dlqJob.name,
            {
                ...dlqJob.data,
                shouldFail: false
            },
            {
                jobId: `replay-${dlqJob.id}`,
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 2000
                }
            }
        );

        res.json({
            message: "DLQ job replayed",
            originalDlqJobId: dlqJob.id,
            newJobId: newJob.id
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to replay DLQ job"
        });
    }
});
app.get("/test-bulk", async (req, res) => {
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
        message: "20 jobs added",
        duration: `${Date.now() - start}ms`,
        jobIds: jobs
    });
});

app.get("/test-delayed", async (req, res) => {
    const job = await emailQueue.add(
        "verification-reminder",
        {
            email: "user@gmail.com"
        },
        {
            delay: 10000
        }
    );

    res.json({
        message: "Delayed email job added",
        jobId: job.id
    });
});
app.get("/test-failure-event", async (req, res) => {
    try {
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
                backoff: {
                    type: "exponential",
                    delay: 2000
                }
            }
        );

        res.json({
            message: "DLQ test job added",
            notificationId: notification.id,
            jobId: job.id
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "DLQ test failed"
        });
    }
});
app.get("/test-priority", async (req, res) => {
    await emailQueue.add(
        "marketing-email",
        {
            email: "marketing@gmail.com"
        },
        {
            priority: 10
        }
    );

    await emailQueue.add(
        "welcome-email",
        {
            email: "welcome@gmail.com"
        },
        {
            priority: 5
        }
    );

    await emailQueue.add(
        "password-reset",
        {
            email: "security@gmail.com"
        },
        {
            priority: 1
        }
    );

    res.json({
        message: "Priority test jobs added"
    });
});
app.get("/test-duplicate", async (req, res) => {
    const jobId = "verification-user-999";

    const job1 = await emailQueue.add(
        "verification-email",
        {
            email: "user@gmail.com"
        },
        {
            jobId
        }
    );

    const job2 = await emailQueue.add(
        "verification-email",
        {
            email: "user@gmail.com"
        },
        {
            jobId
        }
    );

    console.log("Job 1 ID:", job1.id);
    console.log("Job 2 ID:", job2.id);

    console.log("Job 1 state:", await job1.getState());
    console.log("Job 2 state:", await job2.getState());

    res.json({
        firstJobId: job1.id,
        secondJobId: job2.id,
        sameObject: job1 === job2
    });
});
app.get("/test-idempotency", async (req, res) => {
    const idempotencyKey = "notification-user-123";

    await emailQueue.add("verification-email", {
        email: "user@gmail.com",
        idempotencyKey
    });

    await emailQueue.add("verification-email", {
        email: "user@gmail.com",
        idempotencyKey
    });

    res.json({
        message: "Two jobs added"
    });
});
app.get("/test-db", async (req, res) => {
    try {
        const notification = await createNotification(
            "notification-user-123",
            "user@gmail.com",
            "verification-email"
        );

        res.json(notification);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Database error"
        });
    }
});
app.get("/send-notification", async (req, res) => {
    try {
        const idempotencyKey = req.header("Idempotency-Key");

        if (!idempotencyKey) {
            return res.status(400).json({
                message: "Idempotency-Key header is required"
            });
        }

        const result =
            await createNotificationWithOutbox(
                idempotencyKey,
                "user@gmail.com",
                "verification-email"
            );

        res.status(result.created ? 201 : 200).json({
            message: result.created
                ? "Notification created"
                : "Notification already exists",
            notification: result.notification
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to create notification"
        });
    }
});

app.get("/test-db-failure", async (req, res) => {
    try {
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
                backoff: {
                    type: "fixed",
                    delay: 2000
                }
            }
        );

        res.json({
            message: "Failure test queued",
            notificationId: notification.id,
            jobId: job.id
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed"
        });
    }
});
// app.get("/test-claim", async (req, res) => {
//     try {
//         const claimed = await claimNotification(1);

//         res.json({
//             notificationId: 1,
//             claimed
//         });
//     } catch (error) {
//         console.error(error);

//         res.status(500).json({
//             message: "Claim failed"
//         });
//     }
// });
// app.get("/test-retry", async (req, res) => {
//     try {
//         const idempotencyKey = `retry-${Date.now()}`;

//         const notification =
//             await createNotificationWithOutbox(
//                 idempotencyKey,
//                 "retry@gmail.com",
//                 "verification-email"
//             );

//         await emailQueue.add(
//             "verification-email",
//             {
//                 notificationId: notification.id,
//                 email: notification.email,
//                 shouldFail: true
//             },
//             {
//                 attempts: 3,
//                 backoff: {
//                     type: "fixed",
//                     delay: 2000
//                 }
//             }
//         );

//         res.json({
//             message: "Retry test created",
//             notificationId: notification.id
//         });
//     } catch (error) {
//         console.error(error);

//         res.status(500).json({
//             message: "Retry test failed"
//         });
//     }
// });
app.get("/test-rate-limit", async (req, res) => {
    try {
        for (let i = 1; i <= 6; i++) {
            const idempotencyKey = `rate-limit-${Date.now()}-${i}`;

            const notification =
                await createNotificationWithOutbox(
                    idempotencyKey,
                    `rate-${i}@gmail.com`,
                    "verification-email"
                );

            await emailQueue.add(
                "verification-email",
                {
                    notificationId: notification.id,
                    email: notification.email
                },
                {
                    attempts: 1
                }
            );
        }

        res.json({
            message: "6 jobs created"
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Rate limit test failed"
        });
    }
});
app.get("/test-concurrent-claim", async (req, res) => {
    try {
        const idempotencyKey = "notification-concurrent-002";

        const notification = await createNotification(
            idempotencyKey,
            "concurrent@gmail.com",
            "verification-email"
        );

        await emailQueue.add(
            "verification-email",
            {
                notificationId: notification.id,
                email: notification.email
            }
        );

        await emailQueue.add(
            "verification-email",
            {
                notificationId: notification.id,
                email: notification.email
            }
        );

        res.json({
            message: "Two jobs created for one notification",
            notificationId: notification.id
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Test failed"
        });
    }
});
app.get("/test-transaction-rollback", async (req, res) => {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query(
            `
            INSERT INTO notifications
                (idempotency_key, email, type)
            VALUES
                ($1, $2, $3)
            RETURNING id
            `,
            [
                "transaction-test-001",
                "transaction@gmail.com",
                "test-email"
            ]
        );

        const notificationId = result.rows[0].id;

        console.log(
            "Notification inserted:",
            notificationId
        );

        // Intentionally invalid notification ID
        await client.query(
            `
            INSERT INTO notification_outbox
                (notification_id, event_type, payload)
            VALUES
                ($1, $2, $3)
            `,
            [
                999999,
                "test-email",
                JSON.stringify({
                    email: "transaction@gmail.com"
                })
            ]
        );

        await client.query("COMMIT");

        res.json({
            message: "Transaction committed"
        });
    } catch (error) {
        await client.query("ROLLBACK");

        console.error("Transaction rolled back:", error);

        res.status(500).json({
            message: "Transaction rolled back"
        });
    } finally {
        client.release();
    }
});
app.get("/test-outbox", async (req, res) => {
    try {
        const events = await getPendingOutboxEvents();

        res.json({
            count: events.length,
            events
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to read outbox"
        });
    }
});
app.get("/test-outbox-claim", async (req, res) => {
    try {
        const events = await claimPendingOutboxEvents();

        res.json({
            count: events.length,
            events
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Outbox claim failed"
        });
    }
});
app.get("/test-outbox-recovery", async (req, res) => {
    try {
        const recovered = await recoverStuckOutboxEvents();

        res.json({
            count: recovered.length,
            recovered
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Recovery failed"
        });
    }
});

app.get("/queue-stats", async (req, res) => {
    try {
        const counts = await emailQueue.getJobCounts(
            "waiting",
            "active",
            "completed",
            "failed",
            "delayed"
        );

        res.json(counts);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to get queue stats"
        });
    }
});
app.get("/queue-jobs", async (req, res) => {
    try {
        const jobs = await emailQueue.getJobs([
            "waiting",
            "active",
            "completed",
            "failed",
            "delayed"
        ], 0, 9);

        res.json(
            jobs.map((job) => ({
                id: job.id,
                name: job.name,
                data: job.data,
                attemptsMade: job.attemptsMade,
                failedReason: job.failedReason,
                timestamp: job.timestamp
            }))
        );
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to get jobs"
        });
    }
});
db.query("SELECT NOW()")
    .then(() => {
        console.log("PostgreSQL connected");
    })
    .catch((error) => {
        console.error("PostgreSQL connection failed:", error);
    });
app.listen(PORT, () => {
    console.log(`notification service is running on http://localhost:${PORT}`);
});
