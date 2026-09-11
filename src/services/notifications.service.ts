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