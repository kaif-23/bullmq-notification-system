import { Queue } from "bullmq";

export const emailQueue = new Queue("email", {
    connection: {
        host: "localhost",
        port: 6379
    }
});