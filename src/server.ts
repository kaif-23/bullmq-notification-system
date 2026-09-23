import app from "./app.js";
import { db } from "./config/database.js";
import { logError, logInfo, safeErrorContext } from "./utils/logger.js";

const PORT = Number(process.env.PORT) || 3000;

let httpServer: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

db.query("SELECT NOW()")
    .then(() => {
        logInfo("postgresql_connected");

        httpServer = app.listen(PORT, () => {
            logInfo("http_server_started", { port: PORT });
        });
    })
    .catch((error) => {
        logError("postgresql_connection_failed", safeErrorContext(error));
        process.exit(1);
    });

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo("http_server_shutdown_started", { signal });

    if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }

    await db.end();
    logInfo("http_server_shutdown_completed");
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
