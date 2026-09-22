import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { db } from "../../src/config/database.js";

const internalApiKey = "phase-4-test-internal-key";

function uniqueIdempotencyKey(prefix = "api-test") {
    return `${prefix}-${crypto.randomUUID()}`;
}

function validRequest(overrides: Record<string, unknown> = {}) {
    return {
        email: "test@example.com",
        type: "account-verification",
        data: { orderId: "order-123" },
        ...overrides
    };
}

function expectApiError(response: request.Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(response.body.error.message).toEqual(expect.any(String));
    expect(response.body.requestId).toEqual(expect.any(String));
}

describe("notification HTTP API", () => {
    beforeAll(() => {
        process.env.INTERNAL_API_KEY = internalApiKey;
    });

    it("creates a notification and one pending outbox event through the real app", async () => {
        const idempotencyKey = uniqueIdempotencyKey();
        const response = await request(app)
            .post("/api/v1/notifications/email")
            .set("Idempotency-Key", idempotencyKey)
            .send(validRequest());

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            notificationId: expect.any(Number),
            status: "pending"
        });
        expect(response.headers["x-request-id"]).toEqual(expect.any(String));

        const notificationResult = await db.query(
            `SELECT id, email, type, status, attempts
             FROM notifications
             WHERE id = $1`,
            [response.body.notificationId]
        );
        expect(notificationResult.rows).toEqual([
            {
                id: response.body.notificationId,
                email: "test@example.com",
                type: "account-verification",
                status: "pending",
                attempts: 0
            }
        ]);

        const outboxResult = await db.query(
            `SELECT notification_id, event_type, status
             FROM notification_outbox
             WHERE notification_id = $1`,
            [response.body.notificationId]
        );
        expect(outboxResult.rows).toEqual([
            {
                notification_id: response.body.notificationId,
                event_type: "account-verification",
                status: "pending"
            }
        ]);
    });

    it("returns the existing notification for an identical idempotent request", async () => {
        const idempotencyKey = uniqueIdempotencyKey("repeat");
        const payload = validRequest();

        const firstResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("Idempotency-Key", idempotencyKey)
            .send(payload);
        const secondResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("Idempotency-Key", idempotencyKey)
            .send(payload);

        expect(firstResponse.status).toBe(201);
        expect(secondResponse.status).toBe(200);
        expect(secondResponse.body).toEqual(firstResponse.body);

        const counts = await db.query(
            `SELECT
                (SELECT COUNT(*)::int FROM notifications WHERE idempotency_key = $1) AS notification_count,
                (SELECT COUNT(*)::int FROM notification_outbox WHERE notification_id = $2) AS outbox_count`,
            [idempotencyKey, firstResponse.body.notificationId]
        );
        expect(counts.rows[0]).toEqual({ notification_count: 1, outbox_count: 1 });
    });

    it.each([
        ["email", { email: "different@example.com" }],
        ["type", { type: "password-reset" }],
        ["data", { data: { orderId: "different-order" } }]
    ])("rejects idempotency-key reuse when %s changes", async (_field, change) => {
        const idempotencyKey = uniqueIdempotencyKey("conflict");
        const firstResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("Idempotency-Key", idempotencyKey)
            .send(validRequest());
        const conflictResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("Idempotency-Key", idempotencyKey)
            .send(validRequest(change));

        expect(firstResponse.status).toBe(201);
        expectApiError(conflictResponse, 409, "IDEMPOTENCY_KEY_REUSED");

        const counts = await db.query(
            `SELECT
                (SELECT COUNT(*)::int FROM notifications WHERE idempotency_key = $1) AS notification_count,
                (SELECT COUNT(*)::int FROM notification_outbox WHERE notification_id = $2) AS outbox_count`,
            [idempotencyKey, firstResponse.body.notificationId]
        );
        expect(counts.rows[0]).toEqual({ notification_count: 1, outbox_count: 1 });
    });

    it("propagates a supplied request ID and generates one for errors", async () => {
        const suppliedRequestId = "test-request-123";
        const successResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("X-Request-Id", suppliedRequestId)
            .set("Idempotency-Key", uniqueIdempotencyKey("request-id"))
            .send(validRequest());
        const errorResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("Idempotency-Key", uniqueIdempotencyKey("request-id-error"))
            .send(validRequest({ email: "invalid" }));

        expect(successResponse.status).toBe(201);
        expect(successResponse.headers["x-request-id"]).toBe(suppliedRequestId);
        expectApiError(errorResponse, 400, "INVALID_REQUEST");
        expect(errorResponse.headers["x-request-id"]).toBe(errorResponse.body.requestId);
    });

    it.each([
        ["missing email", { email: undefined }, "INVALID_REQUEST"],
        ["invalid email", { email: "invalid" }, "INVALID_REQUEST"],
        ["missing type", { type: undefined }, "INVALID_REQUEST"],
        ["empty type", { type: "" }, "INVALID_REQUEST"],
        ["invalid data type", { data: "not-an-object" }, "INVALID_REQUEST"],
        ["missing data", { data: undefined }, "INVALID_REQUEST"],
        ["extra field", { unexpected: true }, "INVALID_REQUEST"]
    ])("rejects %s", async (_name, change, code) => {
        const payload = validRequest(change);
        for (const [field, value] of Object.entries(payload)) {
            if (value === undefined) {
                delete payload[field];
            }
        }

        const response = await request(app)
            .post("/api/v1/notifications/email")
            .set("Idempotency-Key", uniqueIdempotencyKey("validation"))
            .send(payload);

        expectApiError(response, 400, code);
    });

    it.each([
        ["missing", undefined],
        ["empty", ""],
        ["whitespace", "bad key"]
    ])("rejects %s Idempotency-Key", async (_name, key) => {
        const builder = request(app).post("/api/v1/notifications/email");
        if (key !== undefined) {
            builder.set("Idempotency-Key", key);
        }
        const response = await builder.send(validRequest());

        expectApiError(response, 400, "INVALID_IDEMPOTENCY_KEY");
    });

    it("returns safe errors for malformed JSON and an oversized body", async () => {
        const malformedResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("Content-Type", "application/json")
            .set("Idempotency-Key", uniqueIdempotencyKey("malformed"))
            .send("{\"email\":");
        const oversizedResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("Content-Type", "application/json")
            .set("Idempotency-Key", uniqueIdempotencyKey("large"))
            .send(JSON.stringify(validRequest({ data: { value: "x".repeat(33 * 1024) } })));

        expect(malformedResponse.status).toBe(400);
        expect(malformedResponse.body.error).toEqual({
            code: "INVALID_JSON",
            message: "Request body must contain valid JSON"
        });
        expect(oversizedResponse.status).toBe(413);
        expect(oversizedResponse.body.error).toEqual({
            code: "REQUEST_TOO_LARGE",
            message: "Request body exceeds the 32 KiB limit"
        });
    });

    it("returns only public fields when retrieving a notification", async () => {
        const createResponse = await request(app)
            .post("/api/v1/notifications/email")
            .set("Idempotency-Key", uniqueIdempotencyKey("get"))
            .send(validRequest());
        const response = await request(app).get(
            `/api/v1/notifications/${createResponse.body.notificationId}`
        );

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            notificationId: createResponse.body.notificationId,
            type: "account-verification",
            status: "pending",
            attempts: 0,
            createdAt: expect.any(String),
            updatedAt: expect.any(String)
        });
        expect(response.body.email).toBeUndefined();
        expect(response.body.idempotency_key).toBeUndefined();
        expect(response.body.request_fingerprint).toBeUndefined();
    });

    it("returns 404 for an unknown notification", async () => {
        const response = await request(app).get("/api/v1/notifications/999999999");

        expectApiError(response, 404, "NOTIFICATION_NOT_FOUND");
    });

    describe("internal authentication boundary", () => {
        const endpoints = [
            ["get", "/internal/queue-stats", 200],
            ["get", "/internal/queue-jobs", 200],
            ["get", "/internal/dlq", 200],
            ["get", "/internal/dlq/missing-job", 404],
            ["post", "/internal/dlq/missing-job/retry", 404]
        ] as const;

        it.each(endpoints)("rejects missing credentials for %s %s", async (method, path) => {
            const response = await request(app)[method](path);

            expect(response.status).toBe(401);
            expect(response.body).toEqual({ message: "Invalid internal API credentials" });
        });

        it.each(endpoints)("rejects an incorrect credential for %s %s", async (method, path) => {
            const response = await request(app)
            [method](path)
                .set("X-Internal-Api-Key", "wrong-key");

            expect(response.status).toBe(401);
            expect(response.body).toEqual({ message: "Invalid internal API credentials" });
        });

        it.each(endpoints)("allows the configured credential through %s %s", async (method, path, expectedStatus) => {
            const response = await request(app)
            [method](path)
                .set("X-Internal-Api-Key", internalApiKey);

            expect(response.status).toBe(expectedStatus);
        });

        it("returns 503 when internal authentication is not configured", async () => {
            const configuredKey = process.env.INTERNAL_API_KEY;
            delete process.env.INTERNAL_API_KEY;
            try {
                const response = await request(app).get("/internal/queue-stats");
                expect(response.status).toBe(503);
                expect(response.body).toEqual({ message: "Internal API is not configured" });
            } finally {
                process.env.INTERNAL_API_KEY = configuredKey;
            }
        });
    });
});
