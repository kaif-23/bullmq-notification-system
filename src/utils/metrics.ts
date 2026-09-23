export type MetricLabelKey =
    | "provider"
    | "outcome"
    | "errorCategory"
    | "operation";

export type MetricLabels = Partial<Record<MetricLabelKey, string>>;

type MetricValue = {
    name: string;
    labels: MetricLabels;
    value: number;
};

type TimingValue = MetricValue & {
    count: number;
    totalMs: number;
    maxMs: number;
};

export type MetricsSnapshot = {
    counters: MetricValue[];
    gauges: MetricValue[];
    timings: TimingValue[];
};

const allowedLabelValues: Record<MetricLabelKey, Set<string>> = {
    provider: new Set(["simulated", "resend", "other"]),
    outcome: new Set(["success", "failure", "retryable", "permanent", "other"]),
    errorCategory: new Set([
        "timeout",
        "network",
        "temporary",
        "authentication",
        "invalid_request",
        "unknown",
        "other"
    ]),
    operation: new Set(["notification", "provider", "replay", "other"])
};

const counters = new Map<string, MetricValue>();
const gauges = new Map<string, MetricValue>();
const timings = new Map<string, TimingValue>();

function normalizeLabels(labels: MetricLabels): MetricLabels {
    return Object.entries(labels).reduce<MetricLabels>((normalized, [key, value]) => {
        if (!(key in allowedLabelValues) || typeof value !== "string") return normalized;

        const labelKey = key as MetricLabelKey;
        normalized[labelKey] = allowedLabelValues[labelKey].has(value) ? value : "other";
        return normalized;
    }, {});
}

function keyFor(name: string, labels: MetricLabels): string {
    return `${name}:${JSON.stringify(normalizeLabels(labels))}`;
}

function valueFor(name: string, labels: MetricLabels, value: number): MetricValue {
    return {
        name,
        labels: normalizeLabels(labels),
        value
    };
}

export function incrementCounter(
    name: string,
    labels: MetricLabels = {},
    amount = 1
): void {
    try {
        const normalizedLabels = normalizeLabels(labels);
        const key = keyFor(name, normalizedLabels);
        const current = counters.get(key);

        counters.set(
            key,
            valueFor(name, normalizedLabels, (current?.value ?? 0) + amount)
        );
    } catch {
        // Metrics must never change notification processing control flow.
    }
}

export function setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    try {
        const normalizedLabels = normalizeLabels(labels);
        gauges.set(keyFor(name, normalizedLabels), valueFor(name, normalizedLabels, value));
    } catch {
        // Metrics must never change notification processing control flow.
    }
}

export function observeTiming(
    name: string,
    durationMs: number,
    labels: MetricLabels = {}
): void {
    try {
        const normalizedLabels = normalizeLabels(labels);
        const key = keyFor(name, normalizedLabels);
        const current = timings.get(key);
        const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;

        timings.set(key, {
            name,
            labels: normalizedLabels,
            value: current ? current.value + safeDuration : safeDuration,
            count: (current?.count ?? 0) + 1,
            totalMs: (current?.totalMs ?? 0) + safeDuration,
            maxMs: Math.max(current?.maxMs ?? 0, safeDuration)
        });
    } catch {
        // Metrics must never change notification processing control flow.
    }
}

export function getMetricsSnapshot(): MetricsSnapshot {
    return {
        counters: [...counters.values()],
        gauges: [...gauges.values()],
        timings: [...timings.values()]
    };
}

export function resetMetrics(): void {
    counters.clear();
    gauges.clear();
    timings.clear();
}
