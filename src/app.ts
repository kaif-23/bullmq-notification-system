import express from "express";
import notificationRoutes from "./routes/notification.routes.js";
import dlqRoutes from "./routes/dlq.routes.js";
import queueRoutes from "./routes/queue.routes.js";
import testRoutes from "./routes/test.routes.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { notFoundMiddleware } from "./middleware/not-found.middleware.js";

const app = express();

app.use(express.json());

// Register routes
app.use("/", notificationRoutes);
app.use("/dlq", dlqRoutes);
app.use("/", queueRoutes);
app.use("/", testRoutes);

// 404 handler for unknown routes
app.use(notFoundMiddleware);

// Global error handler
app.use(errorMiddleware);

export default app;
