import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../src/config/database.js";
import { runMigrations } from "../../src/db/migrate.js";

const temporaryDirectories: string[] = [];

function createMigrationPool(): Pool {
    return new Pool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        max: 1
    });
}

async function createMigrationDirectory(sql: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "bullmq-migration-test-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "900_phase_8a_test.sql"), sql, "utf8");
    return directory;
}

afterEach(async () => {
    await db.query(
        "DROP TABLE IF EXISTS phase_8a_migration_events, phase_8a_failed_migration"
    );
    await db.query(
        "DELETE FROM schema_migrations WHERE name = '900_phase_8a_test.sql'"
    );

    while (temporaryDirectories.length > 0) {
        await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
    }
});

describe("migration runner hardening", () => {
    it("serializes concurrent runners with one applied migration record", async () => {
        const directory = await createMigrationDirectory(`
            CREATE TABLE phase_8a_migration_events (
                event_id SERIAL PRIMARY KEY,
                event_name TEXT NOT NULL
            );
            INSERT INTO phase_8a_migration_events (event_name) VALUES ('start');
            SELECT pg_sleep(0.25);
            INSERT INTO phase_8a_migration_events (event_name) VALUES ('finish');
        `);
        const firstPool = createMigrationPool();
        const secondPool = createMigrationPool();

        try {
            await Promise.all([
                runMigrations(firstPool, { migrationsDirectory: directory }),
                runMigrations(secondPool, { migrationsDirectory: directory })
            ]);

            const events = await db.query<{ event_name: string }>(
                "SELECT event_name FROM phase_8a_migration_events ORDER BY event_id"
            );
            const records = await db.query<{ count: string }>(
                "SELECT COUNT(*)::text AS count FROM schema_migrations WHERE name = '900_phase_8a_test.sql'"
            );

            expect(events.rows.map((row) => row.event_name)).toEqual([
                "start",
                "finish"
            ]);
            expect(records.rows[0].count).toBe("1");
        } finally {
            await Promise.all([firstPool.end(), secondPool.end()]);
        }
    });

    it("rolls back a failed migration and permits a later retry", async () => {
        const directory = await createMigrationDirectory(`
            CREATE TABLE phase_8a_failed_migration (id INTEGER);
            THIS IS NOT VALID SQL;
        `);
        const pool = createMigrationPool();

        try {
            await expect(
                runMigrations(pool, { migrationsDirectory: directory })
            ).rejects.toThrow();

            const afterFailure = await db.query<{ table_name: string | null }>(
                "SELECT to_regclass('phase_8a_failed_migration')::text AS table_name"
            );
            const failedRecord = await db.query<{ count: string }>(
                "SELECT COUNT(*)::text AS count FROM schema_migrations WHERE name = '900_phase_8a_test.sql'"
            );

            expect(afterFailure.rows[0].table_name).toBeNull();
            expect(failedRecord.rows[0].count).toBe("0");

            await writeFile(
                join(directory, "900_phase_8a_test.sql"),
                "CREATE TABLE phase_8a_failed_migration (id INTEGER);",
                "utf8"
            );
            await runMigrations(pool, { migrationsDirectory: directory });

            const successfulRecord = await db.query<{ count: string }>(
                "SELECT COUNT(*)::text AS count FROM schema_migrations WHERE name = '900_phase_8a_test.sql'"
            );
            expect(successfulRecord.rows[0].count).toBe("1");
        } finally {
            await pool.end();
        }
    });

    it("skips unchanged applied files and rejects changed applied files", async () => {
        const directory = await createMigrationDirectory(
            "CREATE TABLE phase_8a_failed_migration (id INTEGER);"
        );
        const pool = createMigrationPool();

        try {
            await runMigrations(pool, { migrationsDirectory: directory });
            await runMigrations(pool, { migrationsDirectory: directory });

            await writeFile(
                join(directory, "900_phase_8a_test.sql"),
                "CREATE TABLE phase_8a_failed_migration (id BIGINT);",
                "utf8"
            );

            await expect(
                runMigrations(pool, { migrationsDirectory: directory })
            ).rejects.toThrow("has changed after being applied");
        } finally {
            await pool.end();
        }
    });
});
