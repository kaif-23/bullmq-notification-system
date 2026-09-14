import express from 'express';
import {emailQueue} from './queues/email.queue.js';
import { db } from "./config/database.js";
import { createNotification,claimNotification } from "./services/notifications.service.js";


const app=express();

const PORT=3000;

app.get('/',async (req,res)=>{
    
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
    const job = await emailQueue.add(
        "test-failure",
        {
            email: "failure@gmail.com",
            shouldFail: true
        }
    );

    res.json({
        message: "Failure test job added",
        jobId: job.id
    });
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
        const idempotencyKey = "notification-claim-001";

        const notification = await createNotification(
            idempotencyKey,
            "user@gmail.com",
            "verification-email"
        );

        const job = await emailQueue.add(
            "verification-email",
            {
                notificationId: notification.id,
                email: notification.email,
                idempotencyKey: notification.idempotency_key
            },
            {
                jobId: idempotencyKey
            }
        );

        res.json({
            message: "Notification queued",
            notification,
            jobId: job.id
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
app.get("/test-claim", async (req, res) => {
    try {
        const claimed = await claimNotification(1);

        res.json({
            notificationId: 1,
            claimed
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Claim failed"
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
db.query("SELECT NOW()")
    .then(() => {
        console.log("PostgreSQL connected");
    })
    .catch((error) => {
        console.error("PostgreSQL connection failed:", error);
    });
app.listen(PORT,()=>{
    console.log(`notification service is running on http://localhost:${PORT}`);
});
