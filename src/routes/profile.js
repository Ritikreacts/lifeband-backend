/**
 * routes/profile.js
 *
 * OTP-protected profile editing for LifeBand owners.
 * Mounted at: /profile  (see app.js)
 *
 * Routes
 * ──────
 *   POST /profile/request-otp   Request an edit OTP (same flow as registration)
 *   POST /profile/update        Verify OTP, confirm ownership, apply edits
 *
 * Security model
 * ──────────────
 *   1. Caller supplies phoneNumber + OTP.
 *   2. We derive phoneHash = SHA-256(phone) and verify the OTP session.
 *   3. We look up Owner where { bandId, phoneHash } — BOTH must match.
 *      A valid OTP from a non-owner phone is always rejected (403).
 *   4. Only the five mutable fields are ever written; bandId, phoneHash,
 *      bloodGroup, and all ownership data are permanently immutable.
 */

"use strict";

const { Router } = require("express");
const router = Router();

const Owner            = require("../models/Owner");
const EmergencyProfile = require("../models/EmergencyProfile");
const { sendOtp, verifyOtp, OtpError } = require("../services/otpService");
const { hashPhone }    = require("../utils/hash");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Forward async errors to Express global error handler. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** Fields the owner is allowed to update. Everything else is ignored. */
const MUTABLE_FIELDS = [
  "allergies",
  "medicalConditions",
  "medications",
  "notes",
  "emergencyContact",
];

/**
 * Build the public-safe shape of an EmergencyProfile document.
 * Never expose _id or Mongoose internals.
 */
const formatProfile = (doc) => ({
  bandId:            doc.bandId,
  name:              doc.name              || null,
  bloodGroup:        doc.bloodGroup,
  emergencyContact:  doc.emergencyContact,
  allergies:         doc.allergies         || null,
  medicalConditions: doc.medicalConditions || null,
  medications:       doc.medications       || null,
  notes:             doc.notes             || null,
  updatedAt:         doc.updatedAt         || null,
});

// ─── 1. Request edit OTP ──────────────────────────────────────────────────────
//
//   POST /profile/request-otp
//   Body: { phoneNumber }
//
//   Identical OTP flow to registration — we reuse sendOtp from otpService.
//   We intentionally do NOT validate whether phoneNumber matches any owner
//   here, to avoid leaking which phones have registered bands.

router.post("/request-otp", wrap(async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({
      success: false,
      message: "phoneNumber is required",
    });
  }

  try {
    const result = await sendOtp(phoneNumber);
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

// ─── 2. Verify OTP and update profile ────────────────────────────────────────
//
//   POST /profile/update
//   Body:
//     { bandId, phoneNumber, otp,
//       allergies?, medicalConditions?, medications?, notes?, emergencyContact? }
//
//   Gate 1 — OTP must be valid and still within its 5-minute window.
//   Gate 2 — The verified phone must be the registered owner of bandId.
//   Write  — Only MUTABLE_FIELDS are ever touched; all others are ignored.
//
//   Response: updated EmergencyProfile (same shape as /emergency/:bandId).

router.post("/update", wrap(async (req, res) => {
  const { bandId, phoneNumber, otp, ...rest } = req.body;

  // ── Input validation ────────────────────────────────────────────────────
  const missing = [];
  if (!bandId)      missing.push("bandId");
  if (!phoneNumber) missing.push("phoneNumber");
  if (!otp)         missing.push("otp");

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required fields: ${missing.join(", ")}`,
    });
  }

  // Reject requests that carry no updatable fields at all.
  const updatePayload = {};
  for (const field of MUTABLE_FIELDS) {
    if (rest[field] !== undefined) updatePayload[field] = rest[field];
  }

  if (Object.keys(updatePayload).length === 0) {
    return res.status(400).json({
      success: false,
      message: `No updatable fields provided. Editable fields: ${MUTABLE_FIELDS.join(", ")}`,
    });
  }

  // ── Gate 1: Verify OTP ──────────────────────────────────────────────────
  // verifyOtp consumes the session on success — replay is impossible.
  let phoneHash;
  try {
    const result = await verifyOtp(phoneNumber, String(otp));
    phoneHash = result.phoneHash;
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

  // ── Gate 2: Confirm ownership ───────────────────────────────────────────
  // We derive phoneHash from the now-verified phone and match it against
  // the Owner record for this specific bandId.
  // A correct OTP for a *different* phone that happens to own a *different*
  // band is always rejected here.
  const owner = await Owner.findOne({ bandId, phoneHash });

  if (!owner) {
    // Return 403 regardless of whether the bandId exists, to prevent
    // enumeration of which bands are registered vs. which phones own them.
    return res.status(403).json({
      success: false,
      code: "NOT_OWNER",
      message: "You are not the registered owner of this band",
    });
  }

  // ── Write: apply mutable field updates ────────────────────────────────
  // $set is intentionally constructed from the whitelist — raw `rest`
  // is never spread into the DB query.
  const now = new Date();
  updatePayload.updatedAt = now;

  // `new: true` returns the document as it looks AFTER the update.
  const updated = await EmergencyProfile.findOneAndUpdate(
    { bandId },
    { $set: updatePayload },
    { new: true, runValidators: true }
  );

  if (!updated) {
    // Data-integrity gap: owner exists but no profile (shouldn't happen in
    // normal operation). Surface as 404 rather than a raw 500.
    return res.status(404).json({
      success: false,
      message: "Emergency profile not found for this band",
    });
  }

  return res.status(200).json({
    success: true,
    message: "Profile updated successfully",
    profile: formatProfile(updated),
  });
}));

module.exports = router;
