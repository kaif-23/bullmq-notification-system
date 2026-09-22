export interface EmailProviderErrorOptions {
    code: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
}

export class EmailProviderError extends Error {
    readonly code: string;
    readonly retryable: boolean;

    constructor(options: EmailProviderErrorOptions) {
        super(options.message, { cause: options.cause });
        this.name = "EmailProviderError";
        this.code = options.code;
        this.retryable = options.retryable;
    }
}
