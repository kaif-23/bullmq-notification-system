const processedNotifications = new Set<string>();

export function isAlreadyProcessed(
    idempotencyKey: string
): boolean {
    return processedNotifications.has(idempotencyKey);
}

export function markAsProcessed(
    idempotencyKey: string
): void {
    processedNotifications.add(idempotencyKey);
}