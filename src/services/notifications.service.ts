import { db } from "../config/database.js";

export async function createNotification(
    idempotencyKey: string,
    email: string,
    type: string
) {
    const result = await db.query(
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
export async function claimNotification(
    notificationId: number
): Promise<boolean> {
    const result = await db.query(
        `
        UPDATE notifications
        SET status = 'processing',
            updated_at = NOW()
        WHERE id = $1
          AND status = 'pending'
        RETURNING id
        `,
        [notificationId]
    );

    return result.rowCount === 1;
}