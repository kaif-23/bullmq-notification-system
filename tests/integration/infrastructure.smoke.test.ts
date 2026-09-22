import { describe, expect, it } from "vitest";
import { db } from "../../src/config/database.js";
import { redisClient } from "../../src/config/redis-client.js";

describe("test infrastructure", () => {
    it("uses isolated PostgreSQL and Redis infrastructure with migrated tables", async () => {
        const databaseResult = await db.query<{
            database_name: string;
            environment_name: string;
        }>("SELECT current_database() AS database_name, current_setting('server_version') AS environment_name");
        const tablesResult = await db.query<{ table_name: string }>(
            `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = ANY($1::text[])
            ORDER BY table_name
            `,
            [["schema_migrations", "notifications", "notification_outbox"]]
        );

        expect(process.env.NODE_ENV).toBe("test");
        expect(databaseResult.rows[0].database_name).toBe(process.env.TEST_DB_NAME);
        expect(databaseResult.rows[0].environment_name).toBeTruthy();
        expect(tablesResult.rows.map((row) => row.table_name)).toEqual([
            "notification_outbox",
            "notifications",
            "schema_migrations"
        ]);
        expect(await redisClient.ping()).toBe("PONG");
        expect(redisClient.options.db).toBe(Number(process.env.TEST_REDIS_DB));
    });
});
