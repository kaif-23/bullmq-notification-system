import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import {
	getQueueStats,
	getQueueJobs,
	getOutboxStats,
	getMetrics
} from "../controllers/queue.controller.js";

const router = Router();

// Maintaining original endpoint names for compatibility
router.get("/queue-stats", asyncHandler(getQueueStats));
router.get("/queue-jobs", asyncHandler(getQueueJobs));
router.get("/outbox-stats", asyncHandler(getOutboxStats));
router.get("/metrics", asyncHandler(getMetrics));

export default router;
