import { Request, Response } from "express";
import { emailQueue } from "../queues/email.queue.js";

export const getQueueStats = async (req: Request, res: Response) => {
    const counts = await emailQueue.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed"
    );

    res.json(counts);
};

export const getQueueJobs = async (req: Request, res: Response) => {
    const jobs = await emailQueue.getJobs(
        ["waiting", "active", "completed", "failed", "delayed"],
        0,
        9
    );

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
};
