import "dotenv/config";
import { validateProductionEnvironment } from "./runtime-environment.js";

validateProductionEnvironment();

export const redisConnection = {
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT) || 6379,
    ...(process.env.REDIS_DB
        ? { db: Number.parseInt(process.env.REDIS_DB, 10) }
        : {})
};
