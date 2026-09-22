import { PoolClient } from "pg";
import { db } from "../config/database.js";
import type { Notification } from "../types/notification.types.js";
import type { EmailNotificationRequest } from "../utils/notification-request.js";

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createNotificationWithOutbox(
    idempotencyKey: string,
    request: EmailNotificationRequest,
    requestFingerprint: string,
    requestId?: string
): Promise<
    | { notification: Notification; created: true }
    | { notification: Notification; created: false }
    | { conflict: true }
> {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const notificationResult = await client.query<Notification>(
            `
            INSERT INTO notifications
                (idempotency_key, email, type, request_fingerprint)
            VALUES
                ($1, $2, $3, $4)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING *
            `,
            [idempotencyKey, request.email, request.type, requestFingerprint]
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

            const existing = existingResult.rows[0];
            if (!existing) {
                throw new Error("Idempotent notification lookup returned no row");
            }

            const legacyRequestMatches =
                existing.request_fingerprint === null &&
                existing.email === request.email &&
                existing.type === request.type &&
                Object.keys(request.data).length === 0;

            if (
                existing.request_fingerprint !== requestFingerprint &&
                !legacyRequestMatches
            ) {
                await client.query("ROLLBACK");
                return { conflict: true };
            }

            if (legacyRequestMatches) {
                await client.query(
                    `
                    UPDATE notifications
                    SET request_fingerprint = $2
                    WHERE id = $1
                    `,
                    [existing.id, requestFingerprint]
                );
            }

            await client.query("COMMIT");

            return {
                notification: existing,
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
                request.type,
                JSON.stringify({
                    notificationId: notification.id,
                    email: request.email,
                    type: request.type,
                    data: request.data,
                    requestId
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
                    AND status = 'processing'
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
                    AND status = 'processing'
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