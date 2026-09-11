import { Worker } from "bullmq";

const worker = new Worker(
    "email",
    async (job) => {
        console.log("Processing job:", job.id);
        console.log("Job name:", job.name);
        console.log("Job data:", job.data);

        console.log(`Sending email to ${job.data.email}`);

        await new Promise((resolve) => setTimeout(resolve, 2000));

        console.log("Email sent successfully");
    },
    {
        connection: {
            host: "localhost",
            port: 6379
        }
    }
);

console.log("Email worker started");