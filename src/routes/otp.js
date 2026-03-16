/**
 * routes/otp.js
 *
 * Dedicated OTP endpoints to send and verify OTPs using 2Factor.in.
 * Mounted at: /otp
 *
 * Routes
 * ──────
 *   POST /otp/send    Request an OTP (max 3 req per 10 mins per phone)
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
 * Limit logic: Max 3 OTP requests per phone per 10 minutes.
 * We extract the last 10 digits of the phone number to group requests.
 */
const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3,
  keyGenerator: (req) => {
    // Normalise phone to 10 digits to prevent bypasses like +91999 vs 0999
    if (req.body && req.body.phone) {
      return String(req.body.phone).replace(/\D/g, "").slice(-10);
    }
    // Fallback if phone is missing
    return "missing-phone";
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
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({
      success: false,
      message: "phone is required",
    });
  }

  try {
    const result = await sendOtp(phone);
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
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({
      success: false,
      message: "phone and otp are required",
    });
  }

  try {
    // verifyOtp will delete the session on success and track attempts on failure
    await verifyOtp(phone, otp);
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
