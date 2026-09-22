import { shutdown, startRelay } from "./outbox.relay.js";

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void startRelay();