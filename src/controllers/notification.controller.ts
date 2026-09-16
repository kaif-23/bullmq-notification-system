import { Request, Response } from "express";
import {
    createNotificationWithOutbox,
    getNotificationById
} from "../services/notifications.service.js";

export const createEmailNotification = async (req: Request, res: Response) => {
    const idempotencyKey = req.header("Idempotency-Key");
    const { email, type } = req.body as {
        email?: unknown;
        type?: unknown;
    };

    if (
        !idempotencyKey ||
        typeof email !== "string" ||
        !/^\S+@\S+\.\S+$/.test(email) ||
        typeof type !== "string" ||
        type.trim().length === 0
    ) {
        return res.status(400).json({
            message: "Idempotency-Key header and valid email and type fields are required"
        });
    }

    const result = await createNotificationWithOutbox(
        idempotencyKey,
        email,
        type,
        res.locals.requestId
    );

    res.status(result.created ? 201 : 200).json({
        requestId: res.locals.requestId,
        message: result.created
            ? "Notification created"
            : "Notification already exists",
        notification: {
            id: result.notification.id,
            status: result.notification.status,
            type: result.notification.type,
            createdAt: result.notification.created_at
        }
    });
};

export const getNotificationStatus = async (req: Request, res: Response) => {
    const notificationId = Number(req.params.notificationId);

    if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
        return res.status(400).json({ message: "notificationId must be a positive integer" });
    }

    const notification = await getNotificationById(notificationId);

    if (!notification) {
        return res.status(404).json({ message: "Notification not found" });
    }

    res.json({
        requestId: res.locals.requestId,
        notification: {
            id: notification.id,
            email: notification.email,
            type: notification.type,
            status: notification.status,
            attempts: notification.attempts,
            createdAt: notification.created_at,
            updatedAt: notification.updated_at
        }
    });
};
