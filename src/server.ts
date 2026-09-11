import express from 'express';
import {emailQueue} from './queues/email.queue.js';


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

app.listen(PORT,()=>{
    console.log(`notification service is running on http://localhost:${PORT}`);
});
