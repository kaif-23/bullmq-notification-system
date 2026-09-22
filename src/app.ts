import express from "express";
import notificationRoutes from "./routes/notification.routes.js";
import dlqRoutes from "./routes/dlq.routes.js";
import queueRoutes from "./routes/queue.routes.js";
import { requestIdMiddleware } from "./middleware/request-id.middleware.js";
import { internalAuthMiddleware } from "./middleware/internal-auth.middleware.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { notFoundMiddleware } from "./middleware/not-found.middleware.js";

const app = express();

app.use(express.json({ limit: "32kb" }));
app.use(requestIdMiddleware);

// Register routes
app.use("/api/v1", notificationRoutes);
app.use("/internal", internalAuthMiddleware);
app.use("/internal", queueRoutes);
app.use("/internal/dlq", dlqRoutes);

// 404 handler for unknown routes
app.use(notFoundMiddleware);

// Global error handler
app.use(errorMiddleware);

export default app;
