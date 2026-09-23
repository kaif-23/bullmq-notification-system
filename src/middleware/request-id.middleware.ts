import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";

declare global {
    namespace Express {
        interface Locals {
            requestId: string;
        }
    }
}

export function requestIdMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const suppliedRequestId = req.header("X-Request-Id")?.trim();

    if (
        suppliedRequestId &&
        (suppliedRequestId.length > 128 || !/^[\x21-\x7e]+$/.test(suppliedRequestId))
    ) {
        const requestId = randomUUID();
        res.locals.requestId = requestId;
        res.setHeader("X-Request-Id", requestId);
        return res.status(400).json({
            error: {
                code: "INVALID_REQUEST_ID",
                message: "X-Request-Id must contain 1 to 128 visible characters"
            },
            requestId
        });
    }

    const requestId = suppliedRequestId || randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
}