import type { Pool } from "pg";
import { db } from "../../src/config/database.js";
import { runMigrations } from "../../src/db/migrate.js";

export async function verifyDatabaseConnection(): Promise<void> {
    const result = await db.query<{ database_name: string }>(
        "SELECT current_database() AS database_name"
    );

    if (result.rows[0]?.database_name !== process.env.TEST_DB_NAME) {
        throw new Error(
            `Connected to ${result.rows[0]?.database_name ?? "unknown"}, expected ${process.env.TEST_DB_NAME}`
        );
    }
}

export async function migrateTestDatabase(): Promise<void> {
    await runMigrations(db);
}

export async function cleanTestDatabase(): Promise<void> {
    await db.query(
        "TRUNCATE TABLE notification_outbox, notifications RESTART IDENTITY CASCADE"
    );
}

export async function closeTestDatabase(pool: Pool = db): Promise<void> {
    await pool.end();
}
