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
 *   1. Caller supplies emailAddress + OTP.
 *   2. We derive emailHash = SHA-256(email) and verify the OTP session.
 *   3. We look up Owner where { bandId, emailHash } — BOTH must match.
 *      A valid OTP from a non-owner email is always rejected (403).
 *   4. Only the five mutable fields are ever written; bandId, emailHash,
 *      bloodGroup, and all ownership data are permanently immutable.
 */

"use strict";

const { Router } = require("express");
const router = Router();

const Owner            = require("../models/Owner");
const EmergencyProfile = require("../models/EmergencyProfile");
const { sendOtp, verifyOtp, OtpError } = require("../services/otpService");
const { hashEmail }    = require("../utils/hash");
const jwt              = require("jsonwebtoken");

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
//   Body: { emailAddress }
//
//   Identical OTP flow to registration — we reuse sendOtp from otpService.
//
//   We now validate that the email is the verified owner of the bandId
//   BEFORE dispatching an OTP. This ensures non-owners cannot trigger OTPs.

router.post("/request-otp", wrap(async (req, res) => {
  const { emailAddress, bandId } = req.body;

  if (!emailAddress || !bandId) {
    return res.status(400).json({
      success: false,
      message: "emailAddress and bandId are required",
    });
  }

  const emailHash = hashEmail(emailAddress);
  const owner = await Owner.findOne({ bandId, emailHash });

  if (!owner) {
    return res.status(403).json({
      success: false,
      message: "This email is not the registered owner of this band.",
    });
  }

  try {
    const result = await sendOtp(emailAddress);
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

// ─── 2. Verify OTP and issue Edit Token ──────────────────────────────────────
//
//   POST /profile/verify-otp
//   Body: { emailAddress, otp, bandId }
//
//   Verifies the OTP and issues a 15-minute JWT (editToken) to unlock the UI.

router.post("/verify-otp", wrap(async (req, res) => {
  const { emailAddress, otp, bandId } = req.body;

  if (!emailAddress || !otp || !bandId) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  let emailHash;
  try {
    const result = await verifyOtp(emailAddress, String(otp));
    emailHash = result.emailHash;
  } catch (err) {
    if (err instanceof OtpError) {
      return res.status(err.statusCode).json({
        success: false, code: err.code, message: err.message,
      });
    }
    throw err;
  }

  const owner = await Owner.findOne({ bandId, emailHash });
  if (!owner) {
    return res.status(403).json({ success: false, message: "Not the registered owner." });
  }

  const editToken = jwt.sign(
    { purpose: "edit_profile", bandId, emailHash },
    process.env.JWT_SECRET,
    { expiresIn: "15m" }
  );

  return res.status(200).json({ success: true, editToken });
}));

// ─── 3. Apply profile updates ────────────────────────────────────────────────
//
//   POST /profile/update
//   Body:
//     { editToken, allergies?, medicalConditions?, medications?, notes?, emergencyContact? }
//
//   Gate 1 — OTP must be valid and still within its 5-minute window.
//   Gate 2 — The verified email must be the registered owner of bandId.
//   Write  — Only MUTABLE_FIELDS are ever touched; all others are ignored.
//
//   Response: updated EmergencyProfile (same shape as /emergency/:bandId).

router.post("/update", wrap(async (req, res) => {
  const { editToken, ...rest } = req.body;

  if (!editToken) {
    return res.status(401).json({ success: false, message: "Missing editToken" });
  }

  let decoded;
  try {
    decoded = jwt.verify(editToken, process.env.JWT_SECRET);
    if (decoded.purpose !== "edit_profile") throw new Error("Invalid token purpose");
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired edit session. Please request a new OTP." });
  }

  const { bandId, emailHash } = decoded;

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

  // ── Gate 2: Confirm ownership ───────────────────────────────────────────
  // We double-check the DB in case ownership was rotated or DB was wiped
  // while the token was active.
  // We derive emailHash from the now-verified email and match it against
  // the Owner record for this specific bandId.
  // A correct OTP for a *different* email that happens to own a *different*
  // band is always rejected here.
  const owner = await Owner.findOne({ bandId, emailHash });

  if (!owner) {
    // Return 403 regardless of whether the bandId exists, to prevent
    // enumeration of which bands are registered vs. which emails own them.
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
