require("dotenv").config();

const connectDB = require("./config/db");
const app = require("./app");

const PORT = process.env.PORT || 5000;

const bootstrap = async () => {
  try {
    await connectDB();

    const server = app.listen(PORT, () => {
      console.log(
        `[Server] LifeBand API running on port ${PORT} [${process.env.NODE_ENV || "development"}]`
      );
    });

    // ─── Graceful Shutdown ─────────────────────────────────────────────────
    const shutdown = (signal) => {
      console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);
      server.close(() => {
        console.log("[Server] HTTP server closed.");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // ─── Unhandled Rejections / Exceptions ────────────────────────────────
    process.on("unhandledRejection", (reason) => {
      console.error("[Server] Unhandled Promise Rejection:", reason);
      process.exit(1);
    });

    process.on("uncaughtException", (err) => {
      console.error("[Server] Uncaught Exception:", err);
      process.exit(1);
    });
  } catch (err) {
    console.error("[Server] Bootstrap failed:", err.message);
    process.exit(1);
  }
};

bootstrap();
