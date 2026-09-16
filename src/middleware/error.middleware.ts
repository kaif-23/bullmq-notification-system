import { Request, Response, NextFunction } from "express";

export function errorMiddleware(
    err: any,
    req: Request,
    res: Response,
    next: NextFunction
) {
    console.error("[Global Error Handler]", err);

    const statusCode = err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(statusCode).json({
        error: {
            message,
            ...(process.env.NODE_ENV !== "production" && { stack: err.stack })
        }
    });
}
