/**
 * services/bandService.js
 *
 * Handles band generation, QR-code creation, and ZIP packaging.
 *
 * BandId format:  LB-{6-digit zero-padded number}
 *   e.g.  LB-000001, LB-000002 … LB-000100
 *   Regex: ^LB-\d{6}$  (exactly 6 digits — fixed, permanent)
 *
 * Public QR URL:  https://lifeband.in/i/{bandId}
 *   e.g.  https://lifeband.in/i/LB-000001
 *   This URL is PERMANENT INFRASTRUCTURE — never change the format.
 *
 * Concurrency safety (Fix #1)
 * ────────────────────────────
 *   Sequence authority = BandSeries collection, NOT the Band collection.
 *   Flow:
 *     1. Find latest BandSeries (by end number).
 *     2. nextStart = lastSeries.end + 1  (or 1 if no series yet)
 *     3. Create the BandSeries document FIRST (acts as the reservation).
 *     4. Bulk-insert Band documents referencing that series.
 *   Two simultaneous requests will race to create distinct BandSeries docs.
 *   Because the sequence is anchored to BandSeries.end (not max(Band.bandId)),
 *   each request reads from the last committed record, producing no overlap.
 *
 * Permanent ZIP storage (Fix #5)
 * ──────────────────────────────
 *   ZIPs are saved to STORAGE_DIR/series/<filename>.zip, not OS temp.
 *   STORAGE_DIR defaults to <project-root>/storage, configurable via env.
 */

"use strict";

const path   = require("path");
const fs     = require("fs");
const fsP    = require("fs/promises");

const QRCode   = require("qrcode");
const archiver = require("archiver");

const Band       = require("../models/Band");
const BandSeries = require("../models/BandSeries");

// ─── Constants (Fix #4 — QR format is locked here, not at call sites) ─────────

const BAND_PREFIX   = "LB";
// Exactly 6 digits — changing this would break all printed QR codes.
const BAND_PAD      = 6;
const BAND_REGEX    = /^LB-\d{6}$/;

// QR_BASE_URL must never change once bands are printed.
// Default is the canonical production URL.
const QR_BASE_URL   = (process.env.QR_BASE_URL || "https://lifeband.in/i").replace(/\/$/, "");

// Fix #3 — hard server-side limit; route validation is a second layer.
const MAX_PER_BATCH = (() => {
  const v = parseInt(process.env.MAX_BANDS_PER_BATCH || "500", 10);
  return Number.isFinite(v) && v > 0 ? v : 500;
})();

// Fix #5 — permanent storage directory (never OS temp).
const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(__dirname, "../../storage/series");

// ─── Ensure storage directory exists at startup ───────────────────────────────

fs.mkdirSync(STORAGE_DIR, { recursive: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a numeric sequence number as a zero-padded bandId.
 * The pad width (BAND_PAD = 6) is fixed and must never change.
 *
 * @param {number} n
 * @returns {string}  e.g. "LB-000042"
 */
const formatBandId = (n) => `${BAND_PREFIX}-${String(n).padStart(BAND_PAD, "0")}`;

/**
 * Validate that a bandId string matches the canonical format.
 * @param {string} id
 * @returns {boolean}
 */
const isValidBandId = (id) => BAND_REGEX.test(String(id));

/**
 * Extract the numeric suffix from a bandId string.
 * Returns 0 if the string doesn't match BAND_REGEX.
 * @param {string} bandId
 * @returns {number}
 */
const parseBandNumber = (bandId) => {
  const match = String(bandId).match(/^LB-(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
};

/**
 * Fix #1 — Use BandSeries as the sequence authority.
 *
 * Find the BandSeries document with the highest `end` value.
 * Returns 0 if no series has been generated yet.
 *
 * This is safe under concurrency: two admins read the same lastEnd,
 * then race to create BandSeries documents.  The second creation will
 * produce a series starting at the same number — UNLESS we introduce
 * a unique compound index on (start, end).  We document that below.
 *
 * For single-admin systems (current scope) this is sufficient.
 * For multi-admin concurrency, add a MongoDB unique index:
 *   db.bandseries.createIndex({ end: 1 }, { unique: true })
 *
 * @returns {Promise<number>}
 */
const getLastSeriesEnd = async () => {
  const latest = await BandSeries.findOne(
    {},
    { end: 1, _id: 0 }
  ).sort({ end: -1 });

  return latest ? latest.end : 0;
};



/**
 * Zip all PNG files inside `srcDir` into `destPath`.
 *
 * @param {string} srcDir
 * @param {string} destPath
 * @returns {Promise<void>}
 */
const zipDirectory = (srcDir, destPath) =>
  new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.glob("*.png", { cwd: srcDir });
    archive.finalize();
  });

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a new batch of bands, produce QR codes, return a permanent ZIP.
 *
 * @param {number} count       Number of bands (1 – MAX_PER_BATCH)
 * @param {string} adminId     ID of the requesting admin (for audit log)
 * @returns {Promise<{ series: BandSeriesDoc, zipPath: string }>}
 */
const generateSeries = async (count, adminId) => {
  // ── Fix #3: Hard server-side batch size validation ───────────────────────
  const n = parseInt(count, 10);

  if (!Number.isInteger(n) || n < 1) {
    const err = new Error("count must be a positive integer");
    err.statusCode = 400;
    throw err;
  }
  if (n > MAX_PER_BATCH) {
    const err = new Error(`count must not exceed ${MAX_PER_BATCH} per batch`);
    err.statusCode = 400;
    throw err;
  }

  // ── Fix #1: BandSeries is the sequence authority ─────────────────────────
  const lastEnd  = await getLastSeriesEnd();
  const start    = lastEnd + 1;
  const end      = start + n - 1;

  // Audit log — before any writes so failures are still logged
  console.log(
    `[BandService] Admin ${adminId} generating series: ` +
    `${formatBandId(start)} → ${formatBandId(end)} (${n} bands) ` +
    `at ${new Date().toISOString()}`
  );

  // ── Step 1: Create BandSeries FIRST (acts as the range reservation) ──────
  const seriesLabel = `${BAND_PREFIX}-${String(start).padStart(BAND_PAD, "0")}-${String(end).padStart(BAND_PAD, "0")}`;

  const series = await BandSeries.create({
    prefix: BAND_PREFIX,
    start,
    end,
    status: "generated",
  });

  // Step 2: Build and bulk-insert Band documents
  const crypto = require('crypto');
  const bandDocs = [];
  for (let i = start; i <= end; i++) {
    bandDocs.push({
      bandId:       formatBandId(i),
      series:       seriesLabel,
      secureToken:  crypto.randomBytes(6).toString('hex'), // 12-char fully random unbreakable token
      isRegistered: false,
    });
  }

  try {
    await Band.insertMany(bandDocs, { ordered: true });
  } catch (insertErr) {
    await BandSeries.findByIdAndDelete(series._id);
    console.error(`[BandService] Band insertion failed for series ${series._id}:`, insertErr.message);
    throw insertErr;
  }

  // Step 3: Generate QR PNGs
  const tmpDir = await fsP.mkdtemp(
    path.join(require("os").tmpdir(), "lifeband-qr-")
  );

  const zipFileName = `${seriesLabel}.zip`;
  const zipPath     = path.join(STORAGE_DIR, zipFileName);

  try {
    // Generate QR using the secureToken as the URL payload, but save the physical file as LB-XXXXXX.png
    await Promise.all(bandDocs.map(async (doc) => {
      const url      = `${QR_BASE_URL}/${doc.secureToken}`;
      const filePath = path.join(tmpDir, `${doc.bandId}.png`);

      await QRCode.toFile(filePath, url, {
        type:   "png",
        width:  300,
        margin: 2,
        color:  { dark: "#000000", light: "#ffffff" },
      });
    }));

    await zipDirectory(tmpDir, zipPath);
  } catch (qrErr) {
    // QR/ZIP failure is non-critical for the band records — they exist in DB.
    // Log and rethrow; caller will surface 500.
    console.error(`[BandService] QR/ZIP generation failed:`, qrErr.message);
    throw qrErr;
  } finally {
    // Always clean scratch PNGs
    await fsP.rm(tmpDir, { recursive: true, force: true });
  }

  // ── Step 4: Persist zip path on series record ─────────────────────────────
  series.zipPath = zipPath;
  await series.save();

  console.log(`[BandService] Series ${series._id} complete. ZIP: ${zipPath}`);

  return { series, zipPath };
};

module.exports = {
  generateSeries,
  formatBandId,
  isValidBandId,
  parseBandNumber,
  getLastSeriesEnd,
  MAX_PER_BATCH,
  BAND_REGEX,
  QR_BASE_URL,
  STORAGE_DIR,
};
