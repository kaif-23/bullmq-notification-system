import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db } from "../config/database.js";

const migrationsDirectory = resolve(
    process.env.MIGRATIONS_DIR ?? join(process.cwd(), "migrations")
);

interface MigrationFile {
    name: string;
    sql: string;
    checksum: string;
}

async function readMigrations(): Promise<MigrationFile[]> {
    const names = (await readdir(migrationsDirectory))
        .filter((name) => /^\d+_.+\.sql$/.test(name))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    const migrations = await Promise.all(
        names.map(async (name) => {
            const sql = await readFile(join(migrationsDirectory, name), "utf8");
            return {
                name,
                sql,
                checksum: createHash("sha256").update(sql).digest("hex")
            };
        })
    );

    return migrations;
}

export async function runMigrations(pool = db): Promise<void> {
    const migrations = await readMigrations();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    name TEXT PRIMARY KEY,
                    checksum TEXT NOT NULL,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }

        for (const migration of migrations) {
            const applied = await client.query<{ checksum: string }>(
                "SELECT checksum FROM schema_migrations WHERE name = $1",
                [migration.name]
            );

            if (applied.rows.length > 0) {
                if (applied.rows[0].checksum !== migration.checksum) {
                    throw new Error(
                        `Migration ${migration.name} has changed after being applied`
                    );
                }
                console.log(`[MIGRATE] Already applied ${migration.name}`);
                continue;
            }

            console.log(`[MIGRATE] Applying ${migration.name}`);
            await client.query("BEGIN");
            try {
                await client.query(migration.sql);
                await client.query(
                    `
                    INSERT INTO schema_migrations (name, checksum)
                    VALUES ($1, $2)
                    `,
                    [migration.name, migration.checksum]
                );
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        }

        console.log(`[MIGRATE] Complete (${migrations.length} migration file(s))`);
    } finally {
        client.release();
    }
}

