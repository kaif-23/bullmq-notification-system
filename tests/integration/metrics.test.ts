import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import {
    getMetricsSnapshot,
    incrementCounter,
    observeTiming,
    resetMetrics
} from "../../src/utils/metrics.js";
import { logInfo } from "../../src/utils/logger.js";

const internalApiKey = "phase-4-test-internal-key";

describe("application metrics", () => {
    beforeAll(() => {
        process.env.INTERNAL_API_KEY = internalApiKey;
    });

    beforeEach(() => {
        resetMetrics();
    });

    it("increments counters with bounded labels", () => {
        incrementCounter("provider_failures_total", {
            provider: "resend",
            errorCategory: "timeout"
        });
        incrementCounter("provider_failures_total", {
            provider: "resend",
            errorCategory: "timeout"
        });
        incrementCounter("provider_failures_total", {
            provider: "recipient@example.com",
            errorCategory: "arbitrary-user-input"
        });

        const snapshot = getMetricsSnapshot();
        expect(snapshot.counters).toEqual([
            {
                name: "provider_failures_total",
                labels: { provider: "resend", errorCategory: "timeout" },
                value: 2
            },
            {
                name: "provider_failures_total",
                labels: { provider: "other", errorCategory: "other" },
                value: 1
            }
        ]);
        expect(JSON.stringify(snapshot)).not.toContain("recipient@example.com");
    });

    it("records timing count, total, and maximum without sensitive labels", () => {
        observeTiming("provider_request_duration", 12, { provider: "simulated" });
        observeTiming("provider_request_duration", 8, { provider: "simulated" });

        expect(getMetricsSnapshot().timings).toEqual([
            {
                name: "provider_request_duration",
                labels: { provider: "simulated" },
                value: 20,
                count: 2,
                totalMs: 20,
                maxMs: 12
            }
        ]);
    });

    it("does not throw when observability sinks or inputs fail", () => {
        vi.spyOn(console, "log").mockImplementation(() => {
            throw new Error("log sink unavailable");
        });

        expect(() => logInfo("observability_failure_test")).not.toThrow();
        expect(() => incrementCounter("invalid_labels", null as never)).not.toThrow();
        expect(() => observeTiming("invalid_labels", 10, null as never)).not.toThrow();
    });

    it("serves a current metrics snapshot through the authenticated internal route", async () => {
        incrementCounter("notifications_created_total");

        const response = await request(app)
            .get("/internal/metrics")
            .set("X-Internal-Api-Key", internalApiKey);

        expect(response.status).toBe(200);
        expect(response.body.generatedAt).toEqual(expect.any(String));
        expect(response.body.counters).toEqual([
            {
                name: "notifications_created_total",
                labels: {},
                value: 1
            }
        ]);
        expect(response.body.gauges).toEqual(expect.arrayContaining([
            { name: "queue_waiting", labels: {}, value: expect.any(Number) },
            { name: "outbox_pending", labels: {}, value: expect.any(Number) }
        ]));
    });
});
