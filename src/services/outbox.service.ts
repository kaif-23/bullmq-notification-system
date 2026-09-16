import { PoolClient } from "pg";
import { db } from "../config/database.js";
import type { OutboxEvent } from "../types/notification.types.js";

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Insert a new outbox event using an existing client.
 * Designed to be called inside a transaction that the caller manages.
 * Returns the created outbox event row.
 */
export async function createOutboxEvent(
    client: PoolClient,
    notificationId: number,
    eventType: string,
    payload: Record<string, unknown>
): Promise<OutboxEvent> {
    const result = await client.query<OutboxEvent>(
        `
        INSERT INTO notification_outbox
            (notification_id, event_type, payload)
        VALUES
            ($1, $2, $3)
        RETURNING *
        `,
        [notificationId, eventType, JSON.stringify(payload)]
    );

    return result.rows[0];
}

export async function markOutboxPublished(
    outboxId: number
): Promise<void> {
    await db.query(
        `
        UPDATE notification_outbox
        SET status = 'published',
            published_at = NOW()
        WHERE id = $1
        `,
        [outboxId]
    );
}

// ─── Claim (FOR UPDATE SKIP LOCKED) ──────────────────────────────────────────

export async function claimPendingOutboxEvents(): Promise<OutboxEvent[]> {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query<OutboxEvent>(
            `
            SELECT *
            FROM notification_outbox
            WHERE status = 'pending'
            ORDER BY id
            LIMIT 10
            FOR UPDATE SKIP LOCKED
            `
        );

        if (result.rows.length > 0) {
            const ids = result.rows.map((event) => event.id);

            await client.query(
                `
                UPDATE notification_outbox
                SET status = 'publishing'
                WHERE id = ANY($1::int[])
                `,
                [ids]
            );
        }

        await client.query("COMMIT");

        return result.rows;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

// ─── Recovery ────────────────────────────────────────────────────────────────

export async function recoverStuckOutboxEvents(): Promise<{ id: number }[]> {
    const result = await db.query<{ id: number }>(
        `
        UPDATE notification_outbox
        SET status = 'pending'
        WHERE status = 'publishing'
          AND created_at < NOW() - INTERVAL '5 minutes'
        RETURNING id
        `
    );

    return result.rows;
}