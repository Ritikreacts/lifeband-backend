const crypto = require("crypto");
const { hashOtp } = require("./hash");

const OTP_LENGTH = 6;
// Spec mandates 5-minute OTP TTL; env var allows override in tests
const OTP_TTL_MINUTES = parseInt(process.env.OTP_TTL_MINUTES || "5", 10);
const MAX_OTP_ATTEMPTS = parseInt(process.env.MAX_OTP_ATTEMPTS || "5", 10);

/**
 * Generates a cryptographically random 6-digit numeric OTP.
 * Uses crypto.randomInt so it is uniform and unguessable.
 *
 * @returns {string} zero-padded numeric string e.g. "048213"
 */
const generateOtp = () => {
  const max = Math.pow(10, OTP_LENGTH);
  const raw = crypto.randomInt(0, max);
  return String(raw).padStart(OTP_LENGTH, "0");
};

/**
 * Returns the expiry Date for a new OTP session.
 *
 * @returns {Date}
 */
const getOtpExpiry = () => {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
};

/**
 * Timing-safe comparison between a plain OTP and a stored SHA-256 hash.
 *
 * @param {string} otp        - Plain OTP provided by the user
 * @param {string} storedHash - SHA-256 hex digest from OtpSession
 * @returns {boolean}
 */
const verifyOtpHash = (otp, storedHash) => {
  const attempt = hashOtp(otp);
  return crypto.timingSafeEqual(
    Buffer.from(attempt, "hex"),
    Buffer.from(storedHash, "hex")
  );
};

module.exports = {
  generateOtp,
  getOtpExpiry,
  hashOtp,       // re-exported for convenience
  verifyOtpHash,
  OTP_TTL_MINUTES,
  MAX_OTP_ATTEMPTS,
};

