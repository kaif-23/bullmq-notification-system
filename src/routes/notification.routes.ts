import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { sendNotification } from "../controllers/notification.controller.js";

const router = Router();

router.get("/send-notification", asyncHandler(sendNotification));

export default router;
