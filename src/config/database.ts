import "dotenv/config";
import { Pool } from "pg";

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const db = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: positiveInteger(process.env.DB_PORT, 5432),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "notification_db",
    max: positiveInteger(process.env.DB_POOL_MAX, 10),
    idleTimeoutMillis: positiveInteger(process.env.DB_IDLE_TIMEOUT_MS, 10_000),
    connectionTimeoutMillis: positiveInteger(
        process.env.DB_CONNECTION_TIMEOUT_MS,
        5_000
    ),
    statement_timeout: positiveInteger(
        process.env.DB_STATEMENT_TIMEOUT_MS,
        30_000
    )
});