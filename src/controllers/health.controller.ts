import { Request, Response } from "express";
import { db } from "../config/database.js";
import { logWarn } from "../utils/logger.js";

export function getHealth(_req: Request, res: Response): void {
    res.status(200).json({ status: "ok" });
}

export async function getReadiness(_req: Request, res: Response): Promise<void> {
    try {
        await db.query("SELECT 1");
        res.status(200).json({ status: "ready" });
    } catch (error) {
        logWarn("readiness_check_failed", {
            dependency: "postgresql",
            errorName: error instanceof Error ? error.name : null
        });
        res.status(503).json({ status: "not_ready" });
    }
}
