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

    res.json(await Promise.all(jobs.map(async (job) => ({
        id: job.id,
        name: job.name,
        notificationId: job.data.notificationId,
        type: job.data.type,
        status: await job.getState(),
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn
    }))));
};
