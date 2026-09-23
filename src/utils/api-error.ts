import { Response } from "express";
import { logWarn } from "./logger.js";

export class ApiError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "ApiError";
    }
}

export function sendApiError(
    res: Response,
    statusCode: number,
    code: string,
    message: string
) {
    logWarn("api_request_rejected", {
        requestId: res.locals.requestId,
        statusCode,
        errorCode: code
    });

    return res.status(statusCode).json({
        error: { code, message },
        requestId: res.locals.requestId
    });
}
