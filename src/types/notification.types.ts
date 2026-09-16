export interface Notification {
    id: number;
    idempotency_key: string;
    email: string;
    type: string;
    status: "pending" | "processing" | "sent" | "failed";
    created_at: Date;
    updated_at: Date;
    attempts: number;
}

export interface OutboxEvent {
    id: number;
    notification_id: number;
    event_type: string;
    payload: Record<string, unknown>;
    status: "pending" | "publishing" | "published";
    created_at: Date;
    published_at: Date | null;
}
