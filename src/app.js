const express = require("express");
const publicRouter  = require("./routes/public");
const profileRouter = require("./routes/profile");
const adminRouter   = require("./routes/admin");
const app = express();

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false }));

// ─── Security Headers (Helmet-equivalent manual set) ─────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0"); // Modern browsers handle this natively
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), camera=(), microphone=()"
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'"
  );
  res.removeHeader("X-Powered-By");
  next();
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Public Routes ────────────────────────────────────────────────────────────
app.use("/", publicRouter);

// ─── Profile Routes (OTP-protected) ───────────────────────────────────────────
app.use("/profile", profileRouter);

// ─── Admin Routes (OTP + JWT-protected) ───────────────────────────────────────
app.use("/admin", adminRouter);

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === "production" && statusCode === 500
      ? "Internal server error"
      : err.message || "Internal server error";

  console.error(`[Error] ${req.method} ${req.originalUrl} →`, err);

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

module.exports = app;
