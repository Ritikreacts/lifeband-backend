/**
 * otpService.js
 *
 * Implements the complete OTP lifecycle for LifeBand:
 *   - User registration
 *   - Profile editing
 *   - Admin login
 *
 * Rules (per spec):
 *   - 6-digit numeric OTP
 *   - 5-minute expiry
 *   - Maximum 5 verification attempts before the session is locked
 *
 * Hashing strategy:
 *   - Email addresses  → SHA-256 (via hashEmail)   — stored as emailHash
 *   - OTP values     → SHA-256 (via hashOtp)     — stored as otpHash
 *   - Raw values are NEVER persisted or logged.
 */

"use strict";

const OtpSession = require("../models/OtpSession");
const { hashEmail, hashOtp } = require("../utils/hash");
const { generateOtp, getOtpExpiry, verifyOtpHash, MAX_OTP_ATTEMPTS } = require("../utils/otp");
const { sendOtpEmail } = require("./emailProvider");

// ─── Custom error class ────────────────────────────────────────────────────────

class OtpError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = "OtpError";
    this.code = code;           // machine-readable code for route handlers
    this.statusCode = statusCode;
  }
}

// ─── sendOtp ──────────────────────────────────────────────────────────────────

/**
 * Generate and dispatch an OTP for the given email address.
 *
 * Steps:
 *   1. Normalise and SHA-256 hash the email address.
 *   2. Invalidate any existing active session for this email (one active OTP
 *      per email at a time — prevents session flooding).
 *   3. Generate a cryptographically random 6-digit OTP.
 *   4. Hash the OTP and persist the session with a 5-minute TTL.
 *   5. Dispatch the OTP via the email provider.
 *
 * @param {string} emailAddress - Raw email string
 * @returns {Promise<{ message: string }>}
 * @throws {OtpError}
 */
const sendOtp = async (emailAddress) => {
  if (!emailAddress) {
    throw new OtpError("Email address is required", "EMAIL_REQUIRED");
  }

  const email = String(emailAddress).trim();
  const eHash = hashEmail(email);

  // Invalidate any pre-existing session (prevents parallel session abuse)
  await OtpSession.deleteMany({ emailHash: eHash });

  const otp = generateOtp();
  const otpH = hashOtp(otp);
  const expiresAt = getOtpExpiry();

  await OtpSession.create({
    emailHash: eHash,
    otpHash: otpH,
    expiresAt,
    attempts: 0,
  });

  // Dispatch via email provider
  try {
    await sendOtpEmail(email, otp);
  } catch (emailErr) {
    // Email dispatch failed — delete the session so the user can request a fresh
    // OTP immediately without waiting for TTL expiry.
    await OtpSession.deleteOne({ emailHash: eHash });

    console.error("[OTP] Email delivery failed:", emailErr.message);

    throw new OtpError(
      "Failed to send OTP. Please try again in a moment.",
      "EMAIL_DELIVERY_FAILED",
      503
    );
  }

  return { message: "OTP sent successfully" };
};

// ─── verifyOtp ────────────────────────────────────────────────────────────────

/**
 * Verify an OTP submitted by the user.
 *
 * Steps:
 *   1. Hash the email to find the active OtpSession.
 *   2. Reject if no session exists (expired or never sent).
 *   3. Reject if the session has already hit the max attempt limit.
 *   4. Increment the attempt counter (fail-first; prevents race conditions).
 *   5. Compare the submitted OTP against the stored hash (timing-safe).
 *   6. If correct, delete the session so the OTP cannot be replayed.
 *   7. Return success with the emailHash so the caller can proceed.
 *
 * @param {string} emailAddress - Raw email string (same format as sendOtp)
 * @param {string} otp          - 6-digit OTP submitted by the user
 * @returns {Promise<{ success: true, emailHash: string }>}
 * @throws {OtpError}
 */
const verifyOtp = async (emailAddress, otp) => {
  if (!emailAddress || !otp) {
    throw new OtpError("Email address and OTP are required", "PARAMS_REQUIRED");
  }

  const email = String(emailAddress).trim();
  const eHash = hashEmail(email);

  // Find active session (MongoDB TTL will have already removed expired docs)
  const session = await OtpSession.findOne({ emailHash: eHash });

  if (!session) {
    throw new OtpError(
      "OTP session not found or has expired",
      "SESSION_NOT_FOUND",
      400
    );
  }

  // Guard: has this session already been locked out?
  if (session.attempts >= MAX_OTP_ATTEMPTS) {
    // Remove the locked session so the user can request a new OTP
    await OtpSession.deleteOne({ _id: session._id });
    throw new OtpError(
      "Maximum OTP attempts exceeded. Please request a new OTP.",
      "MAX_ATTEMPTS_EXCEEDED",
      429
    );
  }

  // Increment attempt counter BEFORE comparing — prevents race-condition abuse
  session.attempts += 1;
  await session.save();

  // Timing-safe OTP comparison
  const isValid = verifyOtpHash(String(otp), session.otpHash);

  if (!isValid) {
    const remaining = MAX_OTP_ATTEMPTS - session.attempts;

    if (remaining <= 0) {
      await OtpSession.deleteOne({ _id: session._id });
      throw new OtpError(
        "Maximum OTP attempts exceeded. Please request a new OTP.",
        "MAX_ATTEMPTS_EXCEEDED",
        429
      );
    }

    throw new OtpError(
      `Invalid OTP. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      "INVALID_OTP",
      400
    );
  }

  // OTP is correct — consume the session (one-time use)
  await OtpSession.deleteOne({ _id: session._id });

  return { success: true, emailHash: eHash };
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { sendOtp, verifyOtp, OtpError };
