/**
 * services/smsProvider.js
 *
 * SMS gateway abstraction for LifeBand.
 * Provider: Fast2SMS — OTP Route (no DLT registration required)
 *
 * Fast2SMS OTP route details
 * ──────────────────────────
 *   Endpoint:  POST https://www.fast2sms.com/dev/bulkV2
 *   Auth:      Authorization header (API key)
 *   Route:     "otp"  ← no DLT, lowest cost (~₹0.18/msg)
 *   numbers:   10-digit Indian number without country code
 *   variables_values: the raw OTP digits (e.g. "048213")
 *   flash:     0  (standard inbox delivery)
 *
 * This file exports two functions:
 *   sendOtpSms(phone, otp)   — used by otpService (preferred)
 *   sendSms(phone, message)  — generic fallback (log-only unless extended)
 *
 * Environment variables required:
 *   FAST2SMS_API_KEY  — from https://www.fast2sms.com/dashboard/dev-api
 *   SMS_ENABLED       — set to "true" to send real SMS (any other value = log only)
 */

"use strict";

const axios = require("axios");

const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";
const API_KEY      = process.env.FAST2SMS_API_KEY;
const SMS_ENABLED  = process.env.SMS_ENABLED === "true";

// ─── Phone normalisation ──────────────────────────────────────────────────────

/**
 * Fast2SMS OTP route accepts 10-digit Indian numbers only (no country code).
 * This function strips everything except digits and returns the last 10.
 *
 * "+91 98765 43210"  →  "9876543210"
 * "9876543210"       →  "9876543210"
 * "09876543210"      →  "9876543210"  (strips leading 0)
 *
 * @param {string} phone
 * @returns {string} 10-digit string
 */
const normalisePhone = (phone) => {
  const digits = String(phone).replace(/\D/g, "");
  return digits.slice(-10); // last 10 digits = local Indian number
};

// ─── sendOtpSms ──────────────────────────────────────────────────────────────

/**
 * Send a 6-digit OTP via Fast2SMS OTP route.
 * No DLT registration required.
 *
 * @param {string} phone - Raw phone number (any format)
 * @param {string} otp   - Raw 6-digit OTP (plain text — NOT the hash)
 * @returns {Promise<void>}
 * @throws {Error} if API returns a non-success response
 */
const sendOtpSms = async (phone, otp) => {
  const number = normalisePhone(phone);

  if (!SMS_ENABLED) {
    // Development / CI mode — log to console and return immediately.
    console.log(`[SMS:dev] OTP for ${number}: ${otp}`);
    return;
  }

  if (!API_KEY) {
    throw new Error("FAST2SMS_API_KEY is not set in environment variables");
  }

  try {
    const response = await axios.post(
      FAST2SMS_URL,
      {
        route:            "otp",
        variables_values: String(otp),
        flash:            0,
        numbers:          number,
      },
      {
        headers: {
          authorization: API_KEY,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
        timeout: 10_000, // 10 s — fail fast; don't block OTP response
      }
    );

    // Fast2SMS returns { return: true, status_code: 200, message: [...] }
    // on success.  Any other shape is treated as a failure.
    if (!response.data?.return) {
      const detail = JSON.stringify(response.data);
      console.error(`[SMS] Fast2SMS returned failure for ${number}: ${detail}`);
      throw new Error(`SMS delivery failed: ${detail}`);
    }

    console.log(`[SMS] OTP dispatched to ${number} via Fast2SMS`);
  } catch (err) {
    if (err.response) {
      // Axios received a non-2xx HTTP response
      const detail = JSON.stringify(err.response.data);
      console.error(`[SMS] Fast2SMS HTTP ${err.response.status} for ${number}: ${detail}`);
      throw new Error(`SMS delivery failed (HTTP ${err.response.status}): ${detail}`);
    }
    // Network error, timeout, etc.
    console.error(`[SMS] Fast2SMS request error for ${number}:`, err.message);
    throw err;
  }
};

// ─── sendSms (generic fallback) ───────────────────────────────────────────────

/**
 * Generic SMS sender — currently console-only.
 * Extend this if you need non-OTP SMS (e.g. registration confirmation).
 *
 * @param {string} phone
 * @param {string} message
 * @returns {Promise<void>}
 */
const sendSms = async (phone, message) => {
  console.log(`[SMS] To: ${normalisePhone(phone)} | ${message}`);
};

module.exports = { sendOtpSms, sendSms };
