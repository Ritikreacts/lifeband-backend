/**
 * routes/otp.js
 *
 * Dedicated OTP endpoints to send and verify OTPs using 2Factor.in.
 * Mounted at: /otp
 *
 * Routes
 * ──────
 *   POST /otp/send    Request an OTP (max 3 req per 10 mins per email)
 *   POST /otp/verify  Verify OTP
 */

"use strict";

const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const { sendOtp, verifyOtp, OtpError } = require("../services/otpService");

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Forward async errors to Express global error handler. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * Limit logic: Max 3 OTP requests per email per 10 minutes.
 */
const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3,
  keyGenerator: (req) => {
    if (req.body && req.body.email) {
      return String(req.body.email).trim().toLowerCase();
    }
    // Fallback if email is missing
    return "missing-email";
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many OTP requests. Please try again in 10 minutes.",
  },
});

// ─── POST /otp/send ─────────────────────────────────────────────────────────
router.post("/send", otpSendLimiter, wrap(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "email is required",
    });
  }

  try {
    const result = await sendOtp(email);
    return res.status(200).json({ success: true, message: result.message });
  } catch (err) {
    if (err instanceof OtpError) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    throw err;
  }
}));

// ─── POST /otp/verify ───────────────────────────────────────────────────────
router.post("/verify", wrap(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      message: "email and otp are required",
    });
  }

  try {
    // verifyOtp will delete the session on success and track attempts on failure
    await verifyOtp(email, otp);
    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
    });
  } catch (err) {
    if (err instanceof OtpError) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    throw err;
  }
}));

module.exports = router;
