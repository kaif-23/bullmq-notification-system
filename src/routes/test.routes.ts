import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import * as testController from "../controllers/test.controller.js";

const router = Router();

router.get("/", asyncHandler(testController.testRoot));
router.get("/test-bulk", asyncHandler(testController.testBulk));
router.get("/test-delayed", asyncHandler(testController.testDelayed));
router.get("/test-failure-event", asyncHandler(testController.testFailureEvent));
router.get("/test-priority", asyncHandler(testController.testPriority));
router.get("/test-duplicate", asyncHandler(testController.testDuplicate));
router.get("/test-idempotency", asyncHandler(testController.testIdempotency));
router.get("/test-db", asyncHandler(testController.testDb));
router.get("/test-db-failure", asyncHandler(testController.testDbFailure));
router.get("/test-rate-limit", asyncHandler(testController.testRateLimit));
router.get("/test-concurrent-claim", asyncHandler(testController.testConcurrentClaim));
router.get("/test-transaction-rollback", asyncHandler(testController.testTransactionRollback));
router.get("/test-outbox", asyncHandler(testController.testOutbox));
router.get("/test-outbox-claim", asyncHandler(testController.testOutboxClaim));
router.get("/test-outbox-recovery", asyncHandler(testController.testOutboxRecovery));

export default router;
