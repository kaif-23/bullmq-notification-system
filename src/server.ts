import app from "./app.js";
import { db } from "./config/database.js";

const PORT = Number(process.env.PORT) || 3000;

let httpServer: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

db.query("SELECT NOW()")
    .then(() => {
        console.log("PostgreSQL connected");

        httpServer = app.listen(PORT, () => {
            console.log(`notification service is running on http://localhost:${PORT}`);
        });
    })
    .catch((error) => {
        console.error("PostgreSQL connection failed:", error);
        process.exit(1);
    });

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SERVER] Received ${signal} — shutting down gracefully...`);

    if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }

    await db.end();
    console.log("[SERVER] HTTP server and PostgreSQL pool shut down cleanly");
    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
