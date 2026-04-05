/**
 * routes/admin.js
 *
 * Admin-facing API for LifeBand.
 * Mounted at: /admin  (see app.js)
 *
 * Auth model
 * ──────────
 *   Public  →  POST /admin/request-otp
 *   Public  →  POST /admin/login        (OTP → JWT)
 *   JWT     →  all other /admin/* routes  (adminAuth middleware)
 *
 * Admin is explicitly PROHIBITED from touching EmergencyProfile,
 * Owner, or OtpSession data belonging to users.
 */

"use strict";

const path      = require("path");
const fs        = require("fs");
const rateLimit = require("express-rate-limit");
const { Router } = require("express");

const router     = Router();
const AdminUser  = require("../models/AdminUser");
const Band       = require("../models/Band");
const BandSeries = require("../models/BandSeries");
const adminAuth  = require("../middleware/adminAuth");
const { sendOtp, verifyOtp, OtpError } = require("../services/otpService");
const { generateSeries, MAX_PER_BATCH } = require("../services/bandService");
const { signToken }                    = require("../utils/hash");

// ─── Rate Limiters ────────────────────────────────────────────────────────────

/**
 * Admin OTP rate limit: 5 requests per hour per IP.
 * Protects email sending quotas and prevents enumeration of admin emails.
 */
const adminOtpLimiter = rateLimit({
  windowMs:         60 * 60 * 1000, // 1 hour
  max:              5,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    success: false,
    code:    "RATE_LIMITED",
    message: "Too many OTP requests. Please try again in an hour.",
  },
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Forward async errors to Express global error handler. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ─── 1. Request admin OTP ─────────────────────────────────────────────────────
//
//   POST /admin/request-otp
//   Body: { emailAddress }
//
//   We do NOT validate whether the email is a known admin here — that
//   check happens at login time. This prevents enumeration of admin emails.

router.post("/request-otp", adminOtpLimiter, wrap(async (req, res) => {
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
    throw err;
  }
}));

// ─── 2. Admin login (OTP → JWT) ───────────────────────────────────────────────
//
//   POST /admin/login
//   Body: { emailAddress, otp }
//
//   Steps:
//     a) Verify OTP (consumes session — replay proof).
//     b) Derive emailHash and look up AdminUser.
//     c) If no AdminUser record exists → 403 (not authorised as admin).
//     d) Issue a signed JWT containing { adminId, emailHash, role:"admin" }.

router.post("/login", wrap(async (req, res) => {
  const { emailAddress, otp } = req.body;

  if (!emailAddress || !otp) {
    return res.status(400).json({
      success: false,
      message: "emailAddress and otp are required",
    });
  }

  // Gate 1: OTP verification
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

  // Gate 2: AdminUser existence check
  const admin = await AdminUser.findOne({ emailHash });

  if (!admin) {
    // Deliberate: same message whether OTP was valid-but-not-admin or
    // email simply isn't an admin. Avoids leaking admin email list.
    return res.status(403).json({
      success: false,
      code: "NOT_ADMIN",
      message: "Access denied",
    });
  }

  // Issue JWT
  const token = signToken({
    adminId:   admin._id.toString(),
    emailHash: admin.emailHash,
    role:      "admin",
  });

  return res.status(200).json({
    success: true,
    token,
    message: "Admin login successful",
  });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// All routes below this point require a valid admin JWT.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 3. Dashboard ─────────────────────────────────────────────────────────────
//
//   GET /admin/dashboard
//   Auth: Bearer JWT
//
//   Returns aggregate counts and the latest BandSeries record.
//   NO user emergency data is exposed.

router.get("/dashboard", adminAuth, wrap(async (req, res) => {
  const [totalBands, registeredBands, latestSeries] = await Promise.all([
    Band.countDocuments(),
    Band.countDocuments({ isRegistered: true }),
    BandSeries.findOne().sort({ createdAt: -1 }).lean(),
  ]);

  return res.status(200).json({
    success: true,
    dashboard: {
      totalBands,
      registeredBands,
      unregisteredBands: totalBands - registeredBands,
      latestSeries: latestSeries
        ? {
            id:        latestSeries._id,
            prefix:    latestSeries.prefix,
            start:     latestSeries.start,
            end:       latestSeries.end,
            count:     latestSeries.end - latestSeries.start + 1,
            status:    latestSeries.status,
            createdAt: latestSeries.createdAt,
          }
        : null,
    },
  });
}));

// ─── 4. List all series ───────────────────────────────────────────────────────
//
//   GET /admin/series
//   Auth: Bearer JWT
//
//   Returns all BandSeries records, newest first.
//   zipPath is intentionally excluded from the response (internal path).

router.get("/series", adminAuth, wrap(async (req, res) => {
  const seriesList = await BandSeries.find()
    .sort({ createdAt: -1 })
    .select("-zipPath")     // never expose filesystem paths to the client
    .lean();

  const formatted = seriesList.map((s) => ({
    id:        s._id,
    prefix:    s.prefix,
    start:     s.start,
    end:       s.end,
    count:     s.end - s.start + 1,
    status:    s.status,
    createdAt: s.createdAt,
  }));

  return res.status(200).json({ success: true, series: formatted });
}));

// ─── 5. Generate a new series of bands ───────────────────────────────────────
//
//   POST /admin/generate-series
//   Auth: Bearer JWT
//   Body: { count }   — must be 1..MAX_PER_BATCH (default 500)
//
//   Steps (inside bandService.generateSeries):
//     1. Read latest BandSeries.end → derive start/end (concurrency-safe).
//     2. Create BandSeries document FIRST (sequence reservation).
//     3. Bulk-insert Band documents referencing that series.
//     4. Generate QR PNG per bandId  (URL: https://lifeband.in/i/{bandId})
//     5. Zip PNGs into permanent storage/series/ directory.
//     6. Persist zipPath on the series record.
//
//   The actual ZIP is retrieved via GET /admin/download/:seriesId.

router.post("/generate-series", adminAuth, wrap(async (req, res) => {
  const { count } = req.body;

  // Fix #3 — early route-level validation before hitting the service
  const n = parseInt(count, 10);
  if (!count || !Number.isInteger(n) || n < 1) {
    return res.status(400).json({
      success: false,
      message: "count is required and must be a positive integer",
    });
  }
  if (n > MAX_PER_BATCH) {
    return res.status(400).json({
      success: false,
      message: `count must not exceed ${MAX_PER_BATCH} per batch`,
    });
  }

  // Pass adminId for audit logging inside the service
  const { series } = await generateSeries(n, req.admin.adminId);

  return res.status(201).json({
    success: true,
    message: `${series.end - series.start + 1} bands generated`,
    series: {
      id:          series._id,
      prefix:      series.prefix,
      start:       series.start,
      end:         series.end,
      count:       series.end - series.start + 1,
      status:      series.status,
      createdAt:   series.createdAt,
      downloadUrl: `/admin/download/${series._id}`,
    },
  });
}));

// ─── 6. Download ZIP for a series ────────────────────────────────────────────
//
//   GET /admin/download/:seriesId
//   Auth: Bearer JWT
//
//   Streams the previously-generated ZIP file.
//   Returns 404 if the series or zip file no longer exists.
//   Returns 409 if the ZIP was never generated (edge case: direct DB insert).

router.get("/download/:seriesId", adminAuth, wrap(async (req, res) => {
  const { seriesId } = req.params;

  // Use lean + explicit zipPath inclusion (zipPath excluded from series list
  // select but accessible here via a dedicated fetch).
  const series = await BandSeries.findById(seriesId).lean();

  if (!series) {
    return res.status(404).json({
      success: false,
      message: "Series not found",
    });
  }

  if (!series.zipPath) {
    return res.status(409).json({
      success: false,
      message: "ZIP file has not been generated for this series",
    });
  }

  // Verify the file still exists on disk (could have been cleaned by OS)
  if (!fs.existsSync(series.zipPath)) {
    return res.status(410).json({
      success: false,
      message: "ZIP file no longer available. Please regenerate.",
    });
  }

  const fileName = path.basename(series.zipPath);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

  const stream = fs.createReadStream(series.zipPath);
  stream.on("error", (err) => {
    console.error("[Admin] ZIP stream error:", err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Failed to stream ZIP file" });
    }
  });
  stream.pipe(res);
}));

module.exports = router;
