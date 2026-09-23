export interface ReplayResult {
    outboxEventId: number;
    notificationId: number;
    replayCount: number;
}

export type ReplayError =
    | { code: "DLQ_JOB_NOT_FOUND" }
    | { code: "MISSING_NOTIFICATION_ID" }
    | { code: "INVALID_JOB_DATA" }
    | { code: "MAX_REPLAYS_EXCEEDED"; replayCount: number; max: number }
    | { code: "NOTIFICATION_NOT_FOUND"; notificationId: number }
    | { code: "NOTIFICATION_ALREADY_SENT"; notificationId: number }
    | { code: "NOTIFICATION_NOT_REPLAYABLE"; status: string; notificationId: number }
    | { code: "CONCURRENT_REPLAY"; notificationId: number }
    | { code: "INTERNAL_ERROR"; error: unknown };
