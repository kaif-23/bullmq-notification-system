import { emailQueue } from "../../src/queues/email.queue.js";
import { deadLetterEmailQueue } from "../../src/queues/dead-letter-email.queue.js";

const testQueues = [emailQueue, deadLetterEmailQueue];

export async function cleanTestQueues(): Promise<void> {
    for (const queue of testQueues) {
        await queue.obliterate({ force: true });
    }
}

export async function closeTestQueues(): Promise<void> {
    await Promise.all(testQueues.map((queue) => queue.close()));
}
