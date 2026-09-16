import { Request, Response, NextFunction } from "express";

/**
 * Wraps async route handlers to catch Promise rejections
 * and forward them to Express's global error handler.
 */
export function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
