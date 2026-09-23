import { createHash, timingSafeEqual } from "node:crypto";
import { Request, Response, NextFunction } from "express";

function keysMatch(providedKey: string, configuredKey: string): boolean {
    const providedDigest = createHash("sha256").update(providedKey).digest();
    const configuredDigest = createHash("sha256").update(configuredKey).digest();
    return timingSafeEqual(providedDigest, configuredDigest);
}

export function internalAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const configuredKey = process.env.INTERNAL_API_KEY;

    if (!configuredKey) {
        return res.status(503).json({
            message: "Internal API is not configured"
        });
    }

    const providedKey = req.header("X-Internal-Api-Key");

    if (!providedKey || !keysMatch(providedKey, configuredKey)) {
        return res.status(401).json({
            message: "Invalid internal API credentials"
        });
    }

    next();
}