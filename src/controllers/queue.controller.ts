import { Request, Response } from "express";
import { emailQueue } from "../queues/email.queue.js";
import { db } from "../config/database.js";
import { getMetricsSnapshot, setGauge } from "../utils/metrics.js";

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

export const getMetrics = async (req: Request, res: Response) => {
    const counts = await emailQueue.getJobCounts("waiting", "active", "failed");
    const outboxCounts = await db.query<{ status: string; count: number }>(
        `SELECT status, COUNT(*)::int AS count
         FROM notification_outbox
         GROUP BY status`
    );
    const stalePublishing = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM notification_outbox
         WHERE status = 'publishing'
           AND claimed_at < NOW() - INTERVAL '5 minutes'`
    );
    const outboxByStatus = new Map(
        outboxCounts.rows.map((row) => [row.status, row.count])
    );

    setGauge("queue_waiting", counts.waiting ?? 0);
    setGauge("queue_active", counts.active ?? 0);
    setGauge("queue_failed", counts.failed ?? 0);
    setGauge("outbox_pending", outboxByStatus.get("pending") ?? 0);
    setGauge("outbox_publishing", outboxByStatus.get("publishing") ?? 0);
    setGauge("outbox_stale_publishing", stalePublishing.rows[0]?.count ?? 0);

    res.json({
        generatedAt: new Date().toISOString(),
        ...getMetricsSnapshot()
    });
};

    export const getOutboxStats = async (req: Request, res: Response) => {
        const counts = await db.query<{ status: string; count: number }>(
            `SELECT status, COUNT(*)::int AS count
             FROM notification_outbox
             GROUP BY status`
        );
        const stale = await db.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
             FROM notification_outbox
             WHERE status = 'publishing'
               AND claimed_at < NOW() - INTERVAL '5 minutes'`
        );
        const byStatus = new Map(counts.rows.map((row) => [row.status, row.count]));

        res.json({
            pending: byStatus.get("pending") ?? 0,
            publishing: byStatus.get("publishing") ?? 0,
            published: byStatus.get("published") ?? 0,
            stalePublishing: stale.rows[0]?.count ?? 0
        });
    };
