import "./environment.js";
import { afterAll, beforeAll, beforeEach } from "vitest";
import {
    cleanTestDatabase,
    closeTestDatabase,
    migrateTestDatabase,
    verifyDatabaseConnection
} from "./database.js";
import { cleanTestQueues, closeTestQueues } from "./queues.js";
import { cleanTestRedisKeys, closeTestRedis, verifyRedisConnection } from "./redis.js";

beforeAll(async () => {
    await verifyDatabaseConnection();
    await verifyRedisConnection();
    await migrateTestDatabase();
});

beforeEach(async () => {
    await cleanTestDatabase();
    await cleanTestQueues();
    await cleanTestRedisKeys();
});

afterAll(async () => {
    await cleanTestQueues();
    await cleanTestRedisKeys();
    await closeTestQueues();
    await closeTestRedis();
    await closeTestDatabase();
});
