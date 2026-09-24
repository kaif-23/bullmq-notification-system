import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../config/database.js";

const moduleDirectory = __dirname;
const packagedMigrationsDirectory = resolve(moduleDirectory, "../migrations");
const sourceMigrationsDirectory = resolve(moduleDirectory, "../../migrations");
const defaultMigrationsDirectory = process.env.MIGRATIONS_DIR
    ? resolve(process.env.MIGRATIONS_DIR)
    : existsSync(packagedMigrationsDirectory)
      ? packagedMigrationsDirectory
      : sourceMigrationsDirectory;

const migrationLockName = "bullmq-notification-system:migrations";

interface MigrationFile {
    name: string;
    sql: string;
    checksum: string;
}

async function readMigrations(directory: string): Promise<MigrationFile[]> {
    const names = (await readdir(directory))
        .filter((name) => /^\d+_.+\.sql$/.test(name))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    const migrations = await Promise.all(
        names.map(async (name) => {
            const sql = await readFile(join(directory, name), "utf8");
            return {
                name,
                sql,
                checksum: createHash("sha256").update(sql).digest("hex")
            };
        })
    );

    return migrations;
}

export interface RunMigrationsOptions {
    migrationsDirectory?: string;
}

export async function runMigrations(
    pool = db,
    options: RunMigrationsOptions = {}
): Promise<void> {
    const client = await pool.connect();
    let lockAcquired = false;

    try {
        // A session-level advisory lock is used because each migration keeps its
        // existing transaction boundary. The lock therefore spans discovery,
        // checksum validation, and all migration transactions.
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [migrationLockName]);
        lockAcquired = true;

        const migrations = await readMigrations(
            options.migrationsDirectory ?? defaultMigrationsDirectory
        );

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
        try {
            if (lockAcquired) {
                await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
                    migrationLockName
                ]);
            }
        } finally {
            client.release();
        }
    }
}

