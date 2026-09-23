import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/api-error.js";
import { logError, safeErrorContext } from "../utils/logger.js";

export function errorMiddleware(
    err: any,
    req: Request,
    res: Response,
    next: NextFunction
) {
    const isBodyTooLarge = err?.type === "entity.too.large";
    const isInvalidJson = err instanceof SyntaxError && "body" in err;
    const statusCode = isBodyTooLarge
        ? 413
        : isInvalidJson
            ? 400
            : err instanceof ApiError
                ? err.statusCode
                : Number(err?.statusCode) || 500;
    const code = isBodyTooLarge
        ? "REQUEST_TOO_LARGE"
        : isInvalidJson
            ? "INVALID_JSON"
            : err instanceof ApiError
                ? err.code
                : statusCode >= 500
                    ? "INTERNAL_ERROR"
                    : "REQUEST_ERROR";

    logError("http_request_failed", {
        method: req.method,
        path: req.path,
        requestId: res.locals.requestId,
        statusCode,
        errorCode: err instanceof ApiError ? err.code : code,
        ...safeErrorContext(err)
    });

    const message = isBodyTooLarge
        ? "Request body exceeds the 32 KiB limit"
        : isInvalidJson
            ? "Request body must contain valid JSON"
            : err instanceof ApiError || statusCode < 500
                ? err.message
                : "Internal Server Error";

    res.status(statusCode).json({
        error: { code, message },
        requestId: res.locals.requestId
    });
}
