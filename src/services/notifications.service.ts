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
export async function createNotificationWithOutbox(
    idempotencyKey: string,
    email: string,
    type: string
) {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const notificationResult = await client.query(
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
            const existingResult = await client.query(
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
) {
    const result = await db.query(
        `
        UPDATE notifications
        SET attempts = attempts + 1,
            updated_at = NOW()
        WHERE id = $1
        RETURNING attempts
        `,
        [notificationId]
    );

    return result.rows[0]?.attempts;
}
export async function retryFailedNotification(
    notificationId: number
): Promise<boolean> {
    const result = await db.query(
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