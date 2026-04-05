const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || "7d";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined in environment variables");
}

// ─── Plain SHA-256 Helpers ────────────────────────────────────────────────────
// These are intentionally keyless so that a hash can be re-derived
// from any service without requiring a shared secret at hash time.
// DO NOT log or expose the raw values passed to these functions.

/**
 * Deterministic SHA-256 hash of an email address.
 * Normalises the input (trim + lower) before hashing.
 *
 * @param {string} email - Raw email string
 * @returns {string} hex digest
 */
const hashEmail = (email) => {
  const normalised = String(email).trim().toLowerCase();
  return crypto.createHash("sha256").update(normalised).digest("hex");
};

/**
 * Deterministic SHA-256 hash of a raw OTP string.
 *
 * @param {string} otp - Plain OTP (e.g. "048213")
 * @returns {string} hex digest
 */
const hashOtp = (otp) => {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
};

// ─── HMAC Helper (internal / legacy) ─────────────────────────────────────────
// Kept for any code that relied on the original keyed hash.
// New code should prefer hashEmail / hashOtp above.

const HASH_SECRET = process.env.HASH_SECRET;

/**
 * Creates a deterministic HMAC-SHA256 hash using HASH_SECRET.
 * @param {string} value
 * @returns {string} hex digest
 */
const hashValue = (value) => {
  if (!HASH_SECRET) throw new Error("HASH_SECRET is not defined");
  return crypto
    .createHmac("sha256", HASH_SECRET)
    .update(String(value))
    .digest("hex");
};

// ─── JWT Helpers ──────────────────────────────────────────────────────────────

/**
 * Signs a JWT payload.
 * @param {object} payload
 * @returns {string} signed JWT
 */
const signToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
};

/**
 * Verifies a JWT and returns the decoded payload.
 * Throws if invalid or expired.
 * @param {string} token
 * @returns {object} decoded payload
 */
const verifyToken = (token) => {
  return jwt.verify(token, JWT_SECRET);
};

module.exports = { hashEmail, hashOtp, hashValue, signToken, verifyToken };
