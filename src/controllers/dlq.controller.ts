import { Request, Response } from "express";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
import { replayDlqJob, MAX_REPLAYS } from "../services/dlq.service.js";

export const listDlqJobs = async (req: Request, res: Response) => {
    const jobs = await deadLetterEmailQueue.getJobs(
        ["waiting", "active", "completed", "failed", "delayed"],
        0,
        20
    );

    res.json(
        jobs.map((job) => ({
            id: job.id,
            name: job.name,
            notificationId: job.data.notificationId,
            email: job.data.email,
            originalJobId: job.data.originalJobId,
            failedReason: job.data.failedReason,
            attemptsMade: job.data.attemptsMade,
            replayCount: job.data.replayCount ?? 0,
            maxReplays: MAX_REPLAYS
        }))
    );
};

export const getDlqJob = async (req: Request, res: Response) => {
    const jobId = req.params.jobId as string;
    const job = await deadLetterEmailQueue.getJob(jobId);

    if (!job) {
        return res.status(404).json({ message: "DLQ job not found" });
    }

    res.json({
        id: job.id,
        name: job.name,
        notificationId: job.data.notificationId,
        email: job.data.email,
        originalJobId: job.data.originalJobId,
        failedReason: job.data.failedReason,
        attemptsMade: job.data.attemptsMade,
        replayCount: job.data.replayCount ?? 0,
        maxReplays: MAX_REPLAYS,
        canReplay: (job.data.replayCount ?? 0) < MAX_REPLAYS
    });
};

export const retryDlqJob = async (req: Request, res: Response) => {
    const jobId = req.params.jobId as string;
    console.log(`[DLQ-REPLAY] Replay requested for DLQ job: ${jobId}`);

    const result = await replayDlqJob(jobId);

    if ("outboxEventId" in result) {
        return res.status(202).json({
            message: "Replay queued via outbox - the notification will be retried shortly",
            notificationId: result.notificationId,
            outboxEventId: result.outboxEventId,
            replayCount: result.replayCount
        });
    }

    switch (result.code) {
        case "DLQ_JOB_NOT_FOUND":
            return res.status(404).json({
                error: "DLQ_JOB_NOT_FOUND",
                message: `DLQ job '${jobId}' does not exist`
            });
        case "MISSING_NOTIFICATION_ID":
            return res.status(400).json({
                error: "MISSING_NOTIFICATION_ID",
                message: "DLQ job has no notificationId — cannot replay"
            });
        case "MAX_REPLAYS_EXCEEDED":
            return res.status(409).json({
                error: "MAX_REPLAYS_EXCEEDED",
                message: `This notification has already been replayed ${result.replayCount} time(s). Maximum is ${result.max}.`
            });
        case "NOTIFICATION_NOT_FOUND":
            return res.status(404).json({
                error: "NOTIFICATION_NOT_FOUND",
                message: `Notification ${result.notificationId} not found in database`
            });
        case "NOTIFICATION_ALREADY_SENT":
            return res.status(409).json({
                error: "NOTIFICATION_ALREADY_SENT",
                message: `Notification ${result.notificationId} was already sent - replay not needed`
            });
        case "NOTIFICATION_NOT_REPLAYABLE":
            return res.status(409).json({
                error: "NOTIFICATION_NOT_REPLAYABLE",
                message: `Notification ${result.notificationId} is in status '${result.status}'. Only 'failed' notifications can be replayed.`
            });
        case "CONCURRENT_REPLAY":
            return res.status(409).json({
                error: "CONCURRENT_REPLAY",
                message: `Notification ${result.notificationId} is already being replayed by a concurrent request`
            });
        case "INTERNAL_ERROR":
            console.error("[DLQ-REPLAY] Internal error", result.error);
            return res.status(500).json({
                error: "INTERNAL_ERROR",
                message: "An unexpected error occurred during replay"
            });
    }
};
