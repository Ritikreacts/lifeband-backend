/**
 * services/emailProvider.js
 *
 * Email gateway abstraction for LifeBand.
 * Provider: Nodemailer
 *
 * This file exports generic functions to send OTPs and generic emails.
 *
 * Environment variables required:
 *   SMTP_HOST
 *   SMTP_PORT
 *   SMTP_USER
 *   SMTP_PASS
 *   EMAIL_FROM
 *   EMAIL_ENABLED  — set to "true" to send real emails (any other value = log only)
 */

"use strict";

const nodemailer = require("nodemailer");

const SMTP_HOST     = process.env.SMTP_HOST;
const SMTP_PORT     = process.env.SMTP_PORT;
const SMTP_USER     = process.env.SMTP_USER;
const SMTP_PASS     = process.env.SMTP_PASS;
const EMAIL_FROM    = process.env.EMAIL_FROM || "noreply@lifeband.in";
const EMAIL_ENABLED = process.env.EMAIL_ENABLED === "true";

let transporter = null;
if (EMAIL_ENABLED) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT == 465, // true for 465, false for other ports
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

/**
 * Normalise email (trim, lower)
 */
const normaliseEmail = (email) => {
  return String(email).trim().toLowerCase();
};

/**
 * Send a 6-digit OTP via Email.
 *
 * @param {string} email - Raw email address
 * @param {string} otp   - Raw 6-digit OTP (plain text — NOT the hash)
 * @returns {Promise<void>}
 */
const sendOtpEmail = async (email, otp) => {
  const address = normaliseEmail(email);

  if (!EMAIL_ENABLED) {
    // Development / CI mode — log to console and return immediately.
    console.log(`[Email:dev] OTP for ${address}: ${otp}`);
    return;
  }

  if (!transporter) {
    throw new Error("Transporter is not configured. Please check SMTP environment variables.");
  }

  try {
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to: address,
      subject: "LifeBand Verification Code",
      text: `Your LifeBand verification code is: ${otp}. It will expire in 5 minutes. DO NOT SHARE THIS OTP WITH ANYONE.`,
      html: `<p>Your LifeBand verification code is: <strong>${otp}</strong>.</p><p>It will expire in 5 minutes.</p><p><strong>DO NOT SHARE THIS OTP WITH ANYONE.</strong></p>`,
    });

    console.log(`[Email] OTP dispatched to ${address}. MessageId: ${info.messageId}`);
  } catch (err) {
    console.error(`[Email] delivery failed for ${address}:`, err.message);
    throw new Error(`Email delivery failed: ${err.message}`);
  }
};

/**
 * Generic Email sender — extend this if you need non-OTP Emails.
 *
 * @param {string} email
 * @param {string} message
 * @returns {Promise<void>}
 */
const sendEmail = async (email, subject, message) => {
  const address = normaliseEmail(email);
  if (!EMAIL_ENABLED) {
    console.log(`[Email:dev] To: ${address} | Subj: ${subject} | ${message}`);
    return;
  }
  
  if (!transporter) return;

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: address,
    subject: subject,
    text: message,
  });
};

module.exports = { sendOtpEmail, sendEmail };
