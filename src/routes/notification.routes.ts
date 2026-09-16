import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import {
	createEmailNotification,
	getNotificationStatus
} from "../controllers/notification.controller.js";

const router = Router();

router.post("/notifications/email", asyncHandler(createEmailNotification));
router.get("/notifications/:notificationId", asyncHandler(getNotificationStatus));

export default router;
