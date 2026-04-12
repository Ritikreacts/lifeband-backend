/**
 * scripts/seedAdmins.js
 *
 * One-time seed script to insert admin users into MongoDB.
 * Run from the backend directory:
 *
 *   node src/scripts/seedAdmins.js
 *
 * This script:
 *   1. Connects to the same MongoDB used by the server.
 *   2. Hashes each admin's email (SHA-256) and password (HMAC-SHA256).
 *   3. Upserts AdminUser documents — safe to run multiple times.
 *   4. Logs results and exits.
 */

"use strict";

require("dotenv").config();

const connectDB  = require("../config/db");
const AdminUser  = require("../models/AdminUser");
const { hashEmail, hashValue } = require("../utils/hash");

// ─── Admin accounts to seed ──────────────────────────────────────────────────

const ADMINS = [
  { email: "ritik@gmail.com",  password: "lifeband@admin8080" },
  { email: "himesh@gmail.com", password: "lifeband@admin8080" },
  { email: "ayush@gmail.com",  password: "lifeband@admin8080" },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

const seed = async () => {
  await connectDB();

  console.log("[Seed] Seeding admin users...\n");

  for (const admin of ADMINS) {
    const emailHash    = hashEmail(admin.email);
    const passwordHash = hashValue(admin.password);

    const result = await AdminUser.findOneAndUpdate(
      { emailHash },
      { emailHash, passwordHash },
      { upsert: true, new: true }
    );

    console.log(`  ✓  ${admin.email}`);
    console.log(`     emailHash:    ${emailHash.slice(0, 16)}…`);
    console.log(`     passwordHash: ${passwordHash.slice(0, 16)}…`);
    console.log(`     _id:          ${result._id}\n`);
  }

  console.log(`[Seed] Done — ${ADMINS.length} admin(s) seeded.`);
  process.exit(0);
};

seed().catch((err) => {
  console.error("[Seed] Failed:", err.message);
  process.exit(1);
});
