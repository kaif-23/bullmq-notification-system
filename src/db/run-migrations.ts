import { db } from "../config/database.js";
import { runMigrations } from "./migrate.js";

runMigrations()
    .then(() => db.end())
    .catch((error) => {
        console.error("[MIGRATE] Failed", error);
        process.exitCode = 1;
    });