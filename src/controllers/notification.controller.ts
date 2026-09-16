import { Request, Response } from "express";
import { createNotificationWithOutbox } from "../services/notifications.service.js";

export const sendNotification = async (req: Request, res: Response) => {
    const idempotencyKey = req.header("Idempotency-Key");

    if (!idempotencyKey) {
        return res.status(400).json({
            message: "Idempotency-Key header is required"
        });
    }

    const result = await createNotificationWithOutbox(
        idempotencyKey,
        "user@gmail.com",
        "verification-email"
    );

    res.status(result.created ? 201 : 200).json({
        message: result.created
            ? "Notification created"
            : "Notification already exists",
        notification: result.notification
    });
};
