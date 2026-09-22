export interface EmailJobData {
    notificationId: number;
    email: string;
    type?: string;
    data?: Record<string, unknown>;
    requestId?: string;
    /** Present on DLQ jobs — tracks how many times this notification was replayed */
    replayCount?: number;
    /** Present on DLQ jobs — the original email queue job ID */
    originalJobId?: string;
    /** Present on DLQ jobs — the reason the last attempt failed */
    failedReason?: string;
    /** Present on DLQ jobs — how many BullMQ attempts were made */
    attemptsMade?: number;
}
