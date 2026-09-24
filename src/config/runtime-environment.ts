import "dotenv/config";

const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function requiredProductionValue(
    environment: NodeJS.ProcessEnv,
    name: string
): string {
    const value = environment[name]?.trim();
    if (!value) {
        throw new Error(`Missing required production environment variable: ${name}`);
    }
    return value;
}

function requiredPort(environment: NodeJS.ProcessEnv, name: string): string {
    const value = requiredProductionValue(environment, name);
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid production port in environment variable: ${name}`);
    }
    return value;
}

function rejectLocalHost(value: string, name: string): void {
    if (localHosts.has(value.toLowerCase())) {
        throw new Error(`${name} must not use a local host in production`);
    }
}

export function validateProductionEnvironment(
    environment: NodeJS.ProcessEnv = process.env
): void {
    if (environment.NODE_ENV !== "production") {
        return;
    }

    const dbHost = requiredProductionValue(environment, "DB_HOST");
    const dbUser = requiredProductionValue(environment, "DB_USER");
    const dbPassword = requiredProductionValue(environment, "DB_PASSWORD");
    const dbName = requiredProductionValue(environment, "DB_NAME");
    const redisHost = requiredProductionValue(environment, "REDIS_HOST");

    requiredPort(environment, "DB_PORT");
    requiredPort(environment, "REDIS_PORT");
    rejectLocalHost(dbHost, "DB_HOST");
    rejectLocalHost(redisHost, "REDIS_HOST");

    if (dbUser.toLowerCase() === "postgres") {
        throw new Error("DB_USER must not use the default postgres user in production");
    }

    if (dbPassword.toLowerCase() === "postgres") {
        throw new Error("DB_PASSWORD must not use the default postgres password in production");
    }

    if (dbName.toLowerCase() === "notification_db") {
        throw new Error("DB_NAME must not use the default notification_db in production");
    }
}
