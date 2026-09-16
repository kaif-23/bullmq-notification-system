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
    const requestId = req.header("X-Request-Id")?.trim() || randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
}