/**
 * services/emailProvider.js
 *
 * Email gateway abstraction for LifeBand.
 * Provider: Resend
 *
 * Environment variables required:
 *   RESEND_API_KEY  - Your Resend API key
 *   EMAIL_FROM      - E.g., LifeBand <noreply@lifeband.in> (must be an authenticated domain on Resend)
 *   EMAIL_ENABLED   - Set to "true" to send real emails (any other value = log only)
 */

"use strict";

const { Resend } = require("resend");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM     = process.env.EMAIL_FROM || "LifeBand <noreply@lifeband.in>";
const EMAIL_ENABLED  = process.env.EMAIL_ENABLED === "true";

let resendClient = null;
if (EMAIL_ENABLED) {
  if (!RESEND_API_KEY) {
    console.error("[Email] RESEND_API_KEY is completely missing from your .env but EMAIL_ENABLED is true!");
  } else {
    resendClient = new Resend(RESEND_API_KEY);
  }
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

  if (!resendClient) {
    throw new Error("Resend is not configured. Please check your RESEND_API_KEY in the .env file.");
  }

  try {
    const { data, error } = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: address,
      subject: "Your LifeBand verification code",
      text: `Your LifeBand verification code is: ${otp}. It will expire in 5 minutes. DO NOT SHARE THIS OTP WITH ANYONE.`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border-radius: 8px; border: 1px solid #eaeaea;">
          <h2 style="color: #333; margin-top: 0;">LifeBand Verification</h2>
          <p style="color: #666; font-size: 16px;">Please use the following OTP to complete your request. It will expire in 5 minutes.</p>
          <div style="background-color: #f4f4f5; padding: 16px; border-radius: 6px; text-align: center; margin: 24px 0;">
            <h1 style="margin: 0; color: #18181b; font-size: 32px; letter-spacing: 4px;">${otp}</h1>
          </div>
          <p style="color: #888; font-size: 12px; margin-bottom: 0;"><strong>DO NOT SHARE THIS OTP WITH ANYONE.</strong> If you didn't request this, please ignore this email.</p>
        </div>
      `,
    });

    if (error) {
      console.error(`[Email] Resend API error for ${address}:`, error);
      throw new Error(error.message);
    }

    console.log(`[Email] OTP dispatched to ${address}. Resend ID: ${data?.id}`);
  } catch (err) {
    console.error(`[Email] delivery failed for ${address}:`, err.message);
    throw new Error(`Email delivery failed: ${err.message}`);
  }
};

/**
 * Generic Email sender — extend this if you need non-OTP Emails.
 *
 * @param {string} email
 * @param {string} subject
 * @param {string} message
 * @returns {Promise<void>}
 */
const sendEmail = async (email, subject, message) => {
  const address = normaliseEmail(email);
  if (!EMAIL_ENABLED) {
    console.log(`[Email:dev] To: ${address} | Subj: ${subject} | ${message}`);
    return;
  }
  
  if (!resendClient) return;

  const { error } = await resendClient.emails.send({
    from: EMAIL_FROM,
    to: address,
    subject: subject,
    text: message,
  });

  if (error) {
    console.error(`[Email] delivery failed for ${address}:`, error);
  }
};

module.exports = { sendOtpEmail, sendEmail };
