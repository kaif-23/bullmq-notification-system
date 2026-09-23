import { db } from "../config/database.js";
import { deadLetterEmailQueue } from "../queues/dead-letter-email.queue.js";
import {
    getNotificationById,
    resetNotificationForReplay
} from "./notifications.service.js";
import { createOutboxEvent } from "./outbox.service.js";
import type { EmailJobData } from "../types/email.types.js";
import type { ReplayResult, ReplayError } from "../types/dlq.types.js";
import { logError, logInfo, logWarn, safeErrorContext } from "../utils/logger.js";
import { incrementCounter } from "../utils/metrics.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of times a single notification can be manually replayed
 * from the DLQ. After this limit, replay is rejected with 409.
 * This prevents: DLQ → replay → fail → DLQ → replay → fail → ... infinite loop.
 */
export const MAX_REPLAYS = 3;

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Replay a DLQ job.
 *
 * This function uses the transactional outbox pattern for crash safety:
 *   1. In one DB transaction: notification 'failed' → 'pending' + outbox event
 *   2. The outbox relay picks up the event and enqueues a BullMQ job
 *   3. After successful commit, remove the original DLQ job
 *
 * The failure window between step 1 and step 2 is covered by the relay:
 * if the server crashes after the commit, the relay will still find the
 * pending outbox event on its next poll cycle.
 *
 * If step 3 fails (Redis down), the DLQ job remains. A second replay
 * attempt will be rejected at step 1 because the notification is now
 * 'pending', not 'failed' — so no duplicate replay is possible.
 */
export async function replayDlqJob(
    dlqJobId: string
): Promise<ReplayResult | ReplayError> {
    incrementCounter("replay_attempts_total");
    // ── Step 1: Find the DLQ job ──────────────────────────────────────────────

    const dlqJob = await deadLetterEmailQueue.getJob(dlqJobId);

    if (!dlqJob) {
        logWarn("dlq_replay_job_not_found", { dlqJobId });
        return { code: "DLQ_JOB_NOT_FOUND" };
    }

    const jobData = dlqJob.data as EmailJobData;

    // ── Step 2: Validate job data ─────────────────────────────────────────────

    if (jobData.notificationId == null) {
        logWarn("dlq_replay_missing_notification_id", { dlqJobId });
        return { code: "MISSING_NOTIFICATION_ID" };
    }

    const notificationId = jobData.notificationId;

    // ── Step 3: Enforce replay cap to prevent infinite DLQ loops ─────────────

    const currentReplayCount = jobData.replayCount ?? 0;

    if (
        !Number.isSafeInteger(notificationId) ||
        notificationId <= 0 ||
        !Number.isSafeInteger(currentReplayCount) ||
        currentReplayCount < 0
    ) {
        logWarn("dlq_replay_invalid_job_data", { dlqJobId });
        return { code: "INVALID_JOB_DATA" };
    }

    if (currentReplayCount >= MAX_REPLAYS) {
        logWarn("dlq_replay_limit_reached", {
            dlqJobId,
            notificationId,
            replayCount: currentReplayCount,
            maxReplays: MAX_REPLAYS
        });
        return {
            code: "MAX_REPLAYS_EXCEEDED",
            replayCount: currentReplayCount,
            max: MAX_REPLAYS
        };
    }

    // ── Step 4: Validate the notification exists and can be replayed ──────────

    const notification = await getNotificationById(notificationId);

    if (!notification) {
        logWarn("dlq_replay_notification_not_found", { dlqJobId, notificationId });
        return { code: "NOTIFICATION_NOT_FOUND", notificationId };
    }

    if (notification.status === "sent") {
        logWarn("dlq_replay_notification_already_sent", { dlqJobId, notificationId });
        return { code: "NOTIFICATION_ALREADY_SENT", notificationId };
    }

    if (notification.status !== "failed") {
        logWarn("dlq_replay_notification_not_replayable", {
            dlqJobId,
            notificationId,
            status: notification.status
        });
        return {
            code: "NOTIFICATION_NOT_REPLAYABLE",
            status: notification.status,
            notificationId
        };
    }

    // ── Step 5: Atomic transaction — reset notification + create outbox event ─
    //
    // Both operations happen atomically:
    //   a. UPDATE notifications SET status='pending' WHERE status='failed'
    //   b. INSERT INTO notification_outbox ...
    //
    // If (a) updates 0 rows, another concurrent replay already got there first.
    // We roll back and reject.

    const client = await db.connect();
    let outboxEventId: number;

    try {
        await client.query("BEGIN");

        const reset = await resetNotificationForReplay(client, notificationId);

        if (!reset) {
            await client.query("ROLLBACK");
            logWarn("dlq_replay_concurrent", { dlqJobId, notificationId });
            return { code: "CONCURRENT_REPLAY", notificationId };
        }

        // The outbox event payload mirrors what the outbox relay expects:
        // the same shape as the original notification outbox event.
        const nextReplayCount = currentReplayCount + 1;

        const outboxEvent = await createOutboxEvent(
            client,
            notificationId,
            notification.type,
            {
                notificationId,
                email: notification.email,
                type: notification.type,
                requestId: jobData.requestId,
                // replayCount is carried forward so the email.events.ts
                // handler can propagate it into the next DLQ entry if the
                // replay job also fails permanently.
                replayCount: nextReplayCount
            }
        );

        outboxEventId = outboxEvent.id;

        await client.query("COMMIT");

        logInfo("dlq_replay_queued", {
            dlqJobId,
            notificationId,
            outboxEventId,
            replayCount: nextReplayCount
        });
    } catch (error) {
        await client.query("ROLLBACK");
        logError("dlq_replay_transaction_failed", {
            dlqJobId,
            notificationId,
            ...safeErrorContext(error)
        });
        return { code: "INTERNAL_ERROR", error };
    } finally {
        client.release();
    }

    // ── Step 6: Remove the original DLQ job ───────────────────────────────────
    //
    // This happens AFTER the DB commit, so we never lose the DLQ job
    // before recovery is guaranteed by the outbox.
    //
    // If this fails (e.g. Redis is down), the DLQ job remains.
    // A second replay attempt will be rejected at step 4 because the
    // notification status is now 'pending', not 'failed' — safe.
    try {
        await dlqJob.remove();
        logInfo("dlq_replay_source_removed", { dlqJobId, notificationId });
    } catch (error) {
        logWarn("dlq_replay_source_remove_failed", {
            dlqJobId,
            notificationId,
            ...safeErrorContext(error)
        });
    }

    return {
        outboxEventId: outboxEventId!,
        notificationId,
        replayCount: currentReplayCount + 1
    };
}
