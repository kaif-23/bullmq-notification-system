import { PoolClient } from "pg";
import { db } from "../config/database.js";
import type { Notification } from "../types/notification.types.js";

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createNotification(
    idempotencyKey: string,
    email: string,
    type: string
): Promise<Notification> {
    const result = await db.query<Notification>(
        `
        INSERT INTO notifications
            (idempotency_key, email, type)
        VALUES
            ($1, $2, $3)
        RETURNING *
        `,
        [idempotencyKey, email, type]
    );

    return result.rows[0];
}

export async function createNotificationWithOutbox(
    idempotencyKey: string,
    email: string,
    type: string
): Promise<{ notification: Notification; created: boolean }> {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const notificationResult = await client.query<Notification>(
            `
            INSERT INTO notifications
                (idempotency_key, email, type)
            VALUES
                ($1, $2, $3)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING *
            `,
            [idempotencyKey, email, type]
        );

        if (notificationResult.rows.length === 0) {
            const existingResult = await client.query<Notification>(
                `
                SELECT *
                FROM notifications
                WHERE idempotency_key = $1
                `,
                [idempotencyKey]
            );

            await client.query("COMMIT");

            return {
                notification: existingResult.rows[0],
                created: false
            };
        }

        const notification = notificationResult.rows[0];

        await client.query(
            `
            INSERT INTO notification_outbox
                (notification_id, event_type, payload)
            VALUES
                ($1, $2, $3)
            `,
            [
                notification.id,
                type,
                JSON.stringify({
                    notificationId: notification.id,
                    email: email,
                    type: type,
                    shouldFail: false
                })
            ]
        );

        await client.query("COMMIT");

        return {
            notification,
            created: true
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getNotificationById(
    notificationId: number
): Promise<Notification | null> {
    const result = await db.query<Notification>(
        `
        SELECT *
        FROM notifications
        WHERE id = $1
        `,
        [notificationId]
    );

    return result.rows[0] ?? null;
}

// ─── State transitions ────────────────────────────────────────────────────────

/**
 * Claim a notification for processing.
 * - First attempt: requires status = 'pending'
 * - Retry (attemptsMade > 0): also allows status = 'processing'
 *   (the previous attempt left it in processing after throwing)
 */
export async function claimNotification(
    notificationId: number,
    isRetry: boolean
): Promise<boolean> {
    const result = await db.query(
        `
        UPDATE notifications
        SET status = 'processing',
            updated_at = NOW()
        WHERE id = $1
          AND (
              status = 'pending'
              OR ($2 = true AND status = 'processing')
          )
        RETURNING id
        `,
        [notificationId, isRetry]
    );

    return result.rowCount === 1;
}

export async function incrementNotificationAttempts(
    notificationId: number
): Promise<number> {
    const result = await db.query<{ attempts: number }>(
        `
        UPDATE notifications
        SET attempts = attempts + 1,
            updated_at = NOW()
        WHERE id = $1
        RETURNING attempts
        `,
        [notificationId]
    );

    return result.rows[0]?.attempts ?? 0;
}

export async function markNotificationSent(
    notificationId: number
): Promise<void> {
    await db.query(
        `
        UPDATE notifications
        SET status = 'sent',
            updated_at = NOW()
        WHERE id = $1
        `,
        [notificationId]
    );
}

export async function markNotificationFailed(
    notificationId: number
): Promise<void> {
    await db.query(
        `
        UPDATE notifications
        SET status = 'failed',
            updated_at = NOW()
        WHERE id = $1
        `,
        [notificationId]
    );
}

/**
 * Atomically transition a notification from 'failed' → 'pending' for replay.
 * Must be called inside an existing transaction (caller provides client).
 * Returns true if the row was updated (i.e. it was in 'failed' state).
 * Returns false if the notification was not in 'failed' state (concurrent replay guard).
 */
export async function resetNotificationForReplay(
    client: PoolClient,
    notificationId: number
): Promise<boolean> {
    const result = await client.query(
        `
        UPDATE notifications
        SET status = 'pending',
            updated_at = NOW()
        WHERE id = $1
          AND status = 'failed'
        RETURNING id
        `,
        [notificationId]
    );

    return result.rowCount === 1;
}