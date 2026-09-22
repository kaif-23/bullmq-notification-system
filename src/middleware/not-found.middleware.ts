import { Request, Response } from "express";

export function notFoundMiddleware(req: Request, res: Response) {
    res.status(404).json({
        error: {
            code: "ROUTE_NOT_FOUND",
            message: "Route not found"
        },
        requestId: res.locals.requestId
    });
}
