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

app.listen(PORT,()=>{
    console.log(`notification service is running on http://localhost:${PORT}`);
});
