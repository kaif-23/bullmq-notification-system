import { db } from "../config/database.js";
import { runMigrations } from "./migrate.js";
import { logError, safeErrorContext } from "../utils/logger.js";

async function main(): Promise<void> {
    try {
        await runMigrations();
    } catch (error) {
        logError("migration_failed", safeErrorContext(error));
        process.exitCode = 1;
    } finally {
        try {
            await db.end();
        } catch (error) {
            logError("migration_pool_close_failed", safeErrorContext(error));
            process.exitCode = 1;
        }
    }
}

void main();
