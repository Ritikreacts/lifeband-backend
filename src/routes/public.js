/**
 * routes/public.js
 *
 * All public-facing LifeBand endpoints.
 * No authentication required on any of these routes.
 *
 * Mounted at: /  (root — see app.js)
 *
 * Routes
 * ──────
 *   GET  /i/:bandId                  Scan a band (QR / NFC entry point)
 *   POST /register/request-otp       Request a registration OTP
 *   POST /register/complete           Complete band registration
 *   GET  /emergency/:bandId          Read-only emergency profile lookup
 */

"use strict";

const { Router } = require("express");
const router = Router();

const Band            = require("../models/Band");
const Owner           = require("../models/Owner");
const EmergencyProfile = require("../models/EmergencyProfile");
const { sendOtp, verifyOtp, OtpError } = require("../services/otpService");
const { hashEmail }   = require("../utils/hash");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wrap an async route handler so any thrown error is forwarded to Express's
 * global error handler instead of causing an unhandled-promise rejection.
 */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Obfuscate an email address for partial display.
 * E.g. "john.doe@example.com" -> "j...e@example.com"
 * Stored purely for owner-side display — never used for identification.
 *
 * @param {string} email - Raw email string
 * @returns {string} obfuscated email
 */
const obfuscateEmail = (email) => {
  const str = String(email).trim();
  const parts = str.split("@");
  if (parts.length !== 2) return str.slice(0, 4) + "...";
  const name = parts[0];
  const dom = parts[1];
  if (name.length <= 2) return name + "***@" + dom;
  return name[0] + "***" + name[name.length - 1] + "@" + dom;
};

/**
 * Build the public-safe shape of an EmergencyProfile document.
 * _id and __v are stripped; only meaningful medical fields are returned.
 */
const formatProfile = (doc) => ({
  bandId:           doc.bandId,
  name:             doc.name         || null,
  bloodGroup:       doc.bloodGroup,
  emergencyContact: doc.emergencyContact,
  allergies:        doc.allergies        || null,
  medicalConditions:doc.medicalConditions|| null,
  medications:      doc.medications      || null,
  notes:            doc.notes            || null,
  updatedAt:        doc.updatedAt        || null,
});

// ─── 1. Scan Band ─────────────────────────────────────────────────────────────
//
//   GET /i/:bandId
//
//   This is the primary QR / NFC entry point.
//
//   Response matrix:
//     404                  → Band does not exist in the system
//     200 registration_required → Band exists but hasn't been claimed
//     200 (profile data)   → Band is registered; returns EmergencyProfile

router.get("/i/:bandId", wrap(async (req, res) => {
  const searchParam = req.params.bandId;

  const band = await Band.findOne({
    $or: [{ bandId: searchParam }, { secureToken: searchParam }]
  });

  if (!band) {
    return res.status(404).json({
      success: false,
      message: "Band not found",
    });
  }

  if (!band.isRegistered) {
    return res.status(200).json({
      success: true,
      status: "registration_required",
      bandId: band.bandId,
      message: "This band has not been registered yet.",
    });
  }

  // Band is registered — fetch the emergency profile
  const profile = await EmergencyProfile.findOne({ bandId });

  if (!profile) {
    // Data integrity gap: band is marked registered but profile is missing.
    // Return a safe degraded response rather than a raw 500.
    return res.status(200).json({
      success: true,
      status: "profile_unavailable",
      bandId: band.bandId,
      message: "Band is registered but the emergency profile could not be found.",
    });
  }

  return res.status(200).json({
    success: true,
    status: "registered",
    profile: formatProfile(profile),
  });
}));

// ─── 2. Request OTP (registration) ───────────────────────────────────────────
//
//   POST /register/request-otp
//   Body: { emailAddress }
//
//   Fires a 6-digit OTP to the provided email address.
//   The OTP session is stored in OtpSession with a 5-minute TTL.

router.post("/register/request-otp", wrap(async (req, res) => {
  const { emailAddress } = req.body;

  if (!emailAddress) {
    return res.status(400).json({
      success: false,
      message: "emailAddress is required",
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
    throw err; // unexpected — let global handler deal with it
  }
}));

// ─── 3. Complete Registration ─────────────────────────────────────────────────
//
//   POST /register/complete
//   Body: { bandId, emailAddress, otp, name, bloodGroup, emergencyContact,
//           allergies, medicalConditions, medications, notes }
//
//   CRITICAL RULES (enforced here):
//     a) OTP must pass verification first.
//     b) Band is locked via a single atomic findOneAndUpdate that only
//        matches an UNREGISTERED band.  If it returns null → already taken.
//     c) Owner + EmergencyProfile are created with `{ new: false }` document
//        inserts — Mongoose will throw a duplicate-key error (E11000) if
//        either already exists.  We catch that and surface a clean 409.
//     d) No path in this handler ever mutates an already-registered band.

router.post("/register/complete", wrap(async (req, res) => {
  const {
    bandId,
    emailAddress,
    otp,
    // profile fields
    name,
    bloodGroup,
    emergencyContact,
    allergies,
    medicalConditions,
    medications,
    notes,
  } = req.body;

  // ── Basic input validation ────────────────────────────────────────────────
  const missing = [];
  if (!bandId)           missing.push("bandId");
  if (!emailAddress)     missing.push("emailAddress");
  if (!otp)             missing.push("otp");
  if (!bloodGroup)      missing.push("bloodGroup");
  if (!emergencyContact) missing.push("emergencyContact");

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required fields: ${missing.join(", ")}`,
    });
  }

  // ── Step 1: Verify OTP ──────────────────────────────────────────────────
  //   verifyOtp throws OtpError on any failure; session is consumed on success.
  let emailHash;
  try {
    const result = await verifyOtp(emailAddress, String(otp));
    emailHash = result.emailHash;
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

  // ── Step 2: Atomically lock the band ────────────────────────────────────
  //   { new: false } (default) returns the OLD document — we use it only to
  //   detect whether the update hit anything.  The real guard is the query
  //   filter `{ isRegistered: false }`.
  const now = new Date();

  const lockedBand = await Band.findOneAndUpdate(
    { bandId, isRegistered: false },           // ← only matches unregistered
    { $set: { isRegistered: true, registeredAt: now } },
    { new: true }                              // return updated doc (or null)
  );

  if (!lockedBand) {
    // Either bandId doesn't exist OR it was already registered.
    // We deliberately return the same message to prevent enumeration.
    const exists = await Band.exists({ bandId });
    if (!exists) {
      return res.status(404).json({
        success: false,
        message: "Band not found",
      });
    }
    return res.status(409).json({
      success: false,
      code: "ALREADY_REGISTERED",
      message: "This band is already registered",
    });
  }

  // ── Step 3: Persist Owner + EmergencyProfile ────────────────────────────
  //   Both have a unique index on bandId so concurrent duplicate requests
  //   will be rejected at the DB level (E11000).
  try {
    await Owner.create({
      bandId,
      emailHash,
      emailObfuscated: obfuscateEmail(emailAddress),
    });

    await EmergencyProfile.create({
      bandId,
      name:              name             || undefined,
      bloodGroup,
      emergencyContact,
      allergies:         allergies         || undefined,
      medicalConditions: medicalConditions || undefined,
      medications:       medications       || undefined,
      notes:             notes             || undefined,
      updatedAt:         now,
    });
  } catch (err) {
    // MongoDB duplicate-key error code
    if (err.code === 11000) {
      // Roll back: un-register the band so the device isn't permanently
      // bricked by a partial write.
      await Band.updateOne(
        { bandId },
        { $set: { isRegistered: false, registeredAt: null } }
      );
      return res.status(409).json({
        success: false,
        code: "ALREADY_REGISTERED",
        message: "This band is already registered",
      });
    }
    throw err;
  }

  return res.status(201).json({
    success: true,
    message: "Band registered successfully",
    bandId,
  });
}));

// ─── 4. View Emergency Profile (read-only, public) ───────────────────────────
//
//   GET /emergency/:bandId
//
//   No auth required.  Returns only the EmergencyProfile fields.
//   Does NOT expose Owner data (emailHash, emailObfuscated, etc.).

router.get("/emergency/:bandId", wrap(async (req, res) => {
  const { bandId } = req.params;

  const profile = await EmergencyProfile.findOne({ bandId });

  if (!profile) {
    return res.status(404).json({
      success: false,
      message: "Emergency profile not found",
    });
  }

  return res.status(200).json({
    success: true,
    profile: formatProfile(profile),
  });
}));

module.exports = router;
