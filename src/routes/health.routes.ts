import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { getHealth, getReadiness } from "../controllers/health.controller.js";

const router = Router();

router.get("/health", getHealth);
router.get("/ready", asyncHandler(getReadiness));

export default router;
