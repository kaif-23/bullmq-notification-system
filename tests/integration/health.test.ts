import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import { db } from "../../src/config/database.js";

describe("health and readiness endpoints", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reports liveness without checking dependencies", async () => {
        const response = await request(app).get("/health");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
    });

    it("reports readiness when PostgreSQL is available", async () => {
        const response = await request(app).get("/ready");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ready" });
    });

    it("returns a safe not-ready response when PostgreSQL is unavailable", async () => {
        vi.spyOn(db, "query").mockRejectedValueOnce(
            new Error("postgresql password should not be exposed")
        );

        const response = await request(app).get("/ready");

        expect(response.status).toBe(503);
        expect(response.body).toEqual({ status: "not_ready" });
        expect(JSON.stringify(response.body)).not.toContain("password");
    });
});
