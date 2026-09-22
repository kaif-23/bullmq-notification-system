import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const testEnvironmentFile = resolve(process.cwd(), ".env.test");

if (existsSync(testEnvironmentFile)) {
    config({ path: testEnvironmentFile });
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `Missing ${name}. Tests only use explicit TEST_* infrastructure settings; copy .env.test.example to .env.test.`
        );
    }
    return value;
}

const testDatabaseName = required("TEST_DB_NAME");
const testRedisDb = Number.parseInt(required("TEST_REDIS_DB"), 10);

if (!/(test|ci)/i.test(testDatabaseName)) {
    throw new Error("TEST_DB_NAME must contain 'test' or 'ci' to prevent accidental data loss");
}

if (!Number.isInteger(testRedisDb) || testRedisDb < 1) {
    throw new Error("TEST_REDIS_DB must be a Redis logical database number greater than 0");
}

if (process.env.DB_NAME && process.env.DB_NAME === testDatabaseName) {
    throw new Error("TEST_DB_NAME must not match DB_NAME");
}

process.env.NODE_ENV = "test";
process.env.DB_HOST = required("TEST_DB_HOST");
process.env.DB_PORT = required("TEST_DB_PORT");
process.env.DB_USER = required("TEST_DB_USER");
process.env.DB_PASSWORD = required("TEST_DB_PASSWORD");
process.env.DB_NAME = testDatabaseName;
process.env.REDIS_HOST = required("TEST_REDIS_HOST");
process.env.REDIS_PORT = required("TEST_REDIS_PORT");
process.env.REDIS_DB = String(testRedisDb);
