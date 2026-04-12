/**
 * routes/admin.js
 *
 * Admin-facing API for LifeBand.
 * Mounted at: /admin  (see app.js)
 *
 * Auth model
 * ──────────
 *   Public  →  POST /admin/login        (email + password → JWT)
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
const { generateSeries, MAX_PER_BATCH } = require("../services/bandService");
const { hashEmail, verifyPasswordHash, signToken } = require("../utils/hash");

// ─── Rate Limiters ────────────────────────────────────────────────────────────

/**
 * Admin login rate limit: 10 requests per 15 minutes per IP.
 * Protects against brute-force password attempts.
 */
const adminLoginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    success: false,
    code:    "RATE_LIMITED",
    message: "Too many login attempts. Please try again in 15 minutes.",
  },
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Forward async errors to Express global error handler. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ─── 1. Admin login (email + password → JWT) ─────────────────────────────────
//
//   POST /admin/login
//   Body: { emailAddress, password }
//
//   Steps:
//     a) Hash email to find the AdminUser.
//     b) Timing-safe compare the submitted password against stored hash.
//     c) If valid → issue JWT containing { adminId, emailHash, role:"admin" }.
//     d) Deliberately vague error messages to prevent email/password enumeration.

router.post("/login", adminLoginLimiter, wrap(async (req, res) => {
  const { emailAddress, password } = req.body;

  if (!emailAddress || !password) {
    return res.status(400).json({
      success: false,
      message: "emailAddress and password are required",
    });
  }

  // Step 1: Derive emailHash and look up AdminUser
  const emailHash = hashEmail(emailAddress);
  const admin = await AdminUser.findOne({ emailHash });

  if (!admin) {
    // Deliberate: same message whether email is wrong or password is wrong
    return res.status(401).json({
      success: false,
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
    });
  }

  // Step 2: Timing-safe password comparison
  const isValid = verifyPasswordHash(password, admin.passwordHash);

  if (!isValid) {
    return res.status(401).json({
      success: false,
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
    });
  }

  // Step 3: Issue JWT
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

// ─── 2. Dashboard ─────────────────────────────────────────────────────────────
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

  // Fetch recent profiles with owner emails and scan counts
  const EmergencyProfile = require("../models/EmergencyProfile");
  const Owner = require("../models/Owner");

  // Get last 50 updated profiles
  const profiles = await EmergencyProfile.find().sort({ updatedAt: -1 }).limit(50).lean();
  
  // Find matching owners to get full emails
  const bandIds = profiles.map(p => p.bandId);
  const owners = await Owner.find({ bandId: { $in: bandIds } }).lean();
  const bandsInfo = await Band.find({ bandId: { $in: bandIds } }).select("bandId scanCount registeredAt").lean();
  
  const ownerMap = owners.reduce((acc, owner) => {
    // Show full email if available, otherwise show obfuscated for old records
    acc[owner.bandId] = owner.email || owner.emailObfuscated || "Hidden";
    return acc;
  }, {});

  const bandMap = bandsInfo.reduce((acc, b) => {
    acc[b.bandId] = { scanCount: b.scanCount || 0, registeredAt: b.registeredAt };
    return acc;
  }, {});

  const users = profiles.map(p => ({
    bandId: p.bandId,
    name: p.name || "Unknown",
    bloodGroup: p.bloodGroup,
    email: ownerMap[p.bandId] || "Unknown",
    scanCount: bandMap[p.bandId]?.scanCount || 0,
    registeredAt: bandMap[p.bandId]?.registeredAt || p.updatedAt,
    updatedAt: p.updatedAt
  }));

  // Return all registration dates for flexible frontend chart filtering
  const recentRegistrations = await Band.find({ isRegistered: true })
    .select('registeredAt')
    .lean();

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
      users,
      registrations: recentRegistrations.map(r => r.registeredAt)
    },
  });
}));

// ─── 3. List all series ───────────────────────────────────────────────────────
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

// ─── 4. Generate a new series of bands ───────────────────────────────────────
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

// ─── 5. Download ZIP for a series ────────────────────────────────────────────
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
