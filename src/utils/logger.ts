type LogLevel = "info" | "warn" | "error";

type LogValue = string | number | boolean | null | undefined;

export type LogContext = Record<string, LogValue>;

function write(level: LogLevel, event: string, context: LogContext = {}): void {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        event,
        ...context
    };

    const output = JSON.stringify(entry);
    if (level === "error") {
        console.error(output);
    } else if (level === "warn") {
        console.warn(output);
    } else {
        console.log(output);
    }
}

export function logInfo(event: string, context?: LogContext): void {
    write("info", event, context);
}

export function logWarn(event: string, context?: LogContext): void {
    write("warn", event, context);
}

export function logError(event: string, context?: LogContext): void {
    write("error", event, context);
}
