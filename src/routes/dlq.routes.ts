import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { listDlqJobs, getDlqJob, retryDlqJob } from "../controllers/dlq.controller.js";

const router = Router();

router.get("/", asyncHandler(listDlqJobs));
router.get("/:jobId", asyncHandler(getDlqJob));
router.post("/:jobId/retry", asyncHandler(retryDlqJob));

export default router;
