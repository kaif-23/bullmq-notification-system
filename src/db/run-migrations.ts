import { db } from "../config/database.js";
import { runMigrations } from "./migrate.js";
import { logError, safeErrorContext } from "../utils/logger.js";

runMigrations()
    .then(() => db.end())
    .catch((error) => {
        logError("migration_failed", safeErrorContext(error));
        process.exitCode = 1;
    });