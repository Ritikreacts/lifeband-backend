const mongoose = require("mongoose");

const otpSessionSchema = new mongoose.Schema(
  {
    phoneHash: {
      type: String,
      required: true,
    },
    otpHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index — MongoDB auto-deletes at expiresAt
    },
    attempts: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

module.exports = mongoose.model("OtpSession", otpSessionSchema);
