import { db } from "../config/database.js";

export async function getPendingOutboxEvents() {
    const result = await db.query(
        `
        SELECT *
        FROM notification_outbox
        WHERE status = 'pending'
        ORDER BY id
        LIMIT 10
        `
    );

    return result.rows;
}
export async function markOutboxPublished(
    outboxId: number
) {
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
export async function claimPendingOutboxEvents() {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query(
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
export async function recoverStuckOutboxEvents() {
    const result = await db.query(
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