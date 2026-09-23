import { Request, Response } from "express";
import {
    createNotificationWithOutbox,
    getNotificationById
} from "../services/notifications.service.js";
import { fingerprintEmailNotification } from "../utils/notification-request.js";
import { sendApiError } from "../utils/api-error.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { incrementCounter } from "../utils/metrics.js";

const allowedRequestFields = new Set(["email", "type", "data"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const createEmailNotification = async (req: Request, res: Response) => {
    const idempotencyKey = req.header("Idempotency-Key")?.trim();
    const body = req.body as unknown;

    if (
        !idempotencyKey ||
        idempotencyKey.length > 255 ||
        !/^\S+$/.test(idempotencyKey)
    ) {
        return sendApiError(
            res,
            400,
            "INVALID_IDEMPOTENCY_KEY",
            "Idempotency-Key must be a non-empty value without whitespace and no longer than 255 characters"
        );
    }

    if (!isPlainObject(body)) {
        return sendApiError(res, 400, "INVALID_REQUEST", "Request body must be a JSON object");
    }

    const unexpectedFields = Object.keys(body).filter((field) => !allowedRequestFields.has(field));
    if (unexpectedFields.length > 0) {
        return sendApiError(
            res,
            400,
            "INVALID_REQUEST",
            `Unexpected request field: ${unexpectedFields[0]}`
        );
    }

    const { email, type, data } = body;
    if (
        typeof email !== "string" ||
        !/^\S+@\S+\.\S+$/.test(email) ||
        typeof type !== "string" ||
        type.trim().length === 0 ||
        type.length > 100 ||
        !isPlainObject(data)
    ) {
        return sendApiError(
            res,
            400,
            "INVALID_REQUEST",
            "email, type, and object data fields are required; email and type must be valid"
        );
    }

    const request = { email, type, data };
    const requestFingerprint = fingerprintEmailNotification(request);

    const result = await createNotificationWithOutbox(
        idempotencyKey,
        request,
        requestFingerprint,
        res.locals.requestId
    );

    if ("conflict" in result) {
        logWarn("notification_idempotency_conflict", {
            requestId: res.locals.requestId,
            idempotencyKey
        });
        return sendApiError(
            res,
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency-Key was already used with a different request"
        );
    }

    logInfo(result.created ? "notification_created" : "notification_idempotency_reused", {
        requestId: res.locals.requestId,
        notificationId: result.notification.id,
        idempotencyKey
    });

    if (result.created) {
        incrementCounter("notifications_created_total");
    }

    res.status(result.created ? 201 : 200).json({
        notificationId: result.notification.id,
        status: result.notification.status
    });
};

export const getNotificationStatus = async (req: Request, res: Response) => {
    const notificationId = Number(req.params.notificationId);

    if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
        return sendApiError(
            res,
            400,
            "INVALID_NOTIFICATION_ID",
            "notificationId must be a positive integer"
        );
    }

    const notification = await getNotificationById(notificationId);

    if (!notification) {
        return sendApiError(res, 404, "NOTIFICATION_NOT_FOUND", "Notification not found");
    }

    res.json({
        notificationId: notification.id,
        type: notification.type,
        status: notification.status,
        attempts: notification.attempts,
        createdAt: notification.created_at,
        updatedAt: notification.updated_at
    });
};
