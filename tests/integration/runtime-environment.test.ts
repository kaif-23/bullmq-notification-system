import { describe, expect, it } from "vitest";
import { validateProductionEnvironment } from "../../src/config/runtime-environment.js";

const validProductionEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    DB_HOST: "postgres.example.internal",
    DB_PORT: "5432",
    DB_USER: "notification_app",
    DB_PASSWORD: "a-production-secret",
    DB_NAME: "notification_production",
    REDIS_HOST: "redis.example.internal",
    REDIS_PORT: "6379"
};

describe("production runtime environment validation", () => {
    it("accepts explicit non-local PostgreSQL and Redis settings", () => {
        expect(() =>
            validateProductionEnvironment(validProductionEnvironment)
        ).not.toThrow();
    });

    it("does not apply production validation to local or test environments", () => {
        expect(() => validateProductionEnvironment({ NODE_ENV: "test" })).not.toThrow();
        expect(() => validateProductionEnvironment({ NODE_ENV: "development" })).not.toThrow();
    });

    it("rejects missing production settings", () => {
        const environment = { ...validProductionEnvironment };
        delete environment.DB_HOST;

        expect(() => validateProductionEnvironment(environment)).toThrow(
            "DB_HOST"
        );
    });

    it("rejects local hosts and default PostgreSQL credentials", () => {
        expect(() =>
            validateProductionEnvironment({
                ...validProductionEnvironment,
                DB_HOST: "localhost"
            })
        ).toThrow("DB_HOST must not use a local host");

        expect(() =>
            validateProductionEnvironment({
                ...validProductionEnvironment,
                DB_USER: "postgres"
            })
        ).toThrow("DB_USER must not use the default postgres user");

        expect(() =>
            validateProductionEnvironment({
                ...validProductionEnvironment,
                DB_PASSWORD: "postgres"
            })
        ).toThrow("DB_PASSWORD must not use the default postgres password");
    });

    it("rejects invalid ports and the default database name", () => {
        expect(() =>
            validateProductionEnvironment({
                ...validProductionEnvironment,
                REDIS_PORT: "70000"
            })
        ).toThrow("REDIS_PORT");

        expect(() =>
            validateProductionEnvironment({
                ...validProductionEnvironment,
                DB_NAME: "notification_db"
            })
        ).toThrow("DB_NAME must not use the default notification_db");
    });
});
