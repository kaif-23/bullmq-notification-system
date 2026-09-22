export interface EmailSendRequest {
    to: string;
    idempotencyKey: string;
    from?: string;
    subject?: string;
    text?: string;
    html?: string;
}

export type SendEmailResult =
    | { status: "sent" }
    | { status: "skipped"; reason: "already_sent" | "already_processing" };

export interface EmailProvider {
    send(request: EmailSendRequest): Promise<SendEmailResult>;
}
