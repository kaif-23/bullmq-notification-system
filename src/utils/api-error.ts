import { Response } from "express";

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
    return res.status(statusCode).json({
        error: { code, message },
        requestId: res.locals.requestId
    });
}
