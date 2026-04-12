const mongoose = require("mongoose");

const ownerSchema = new mongoose.Schema(
  {
    bandId: {
      type: String,
      unique: true,
      index: true,
      trim: true,
    },
    emailHash: {
      type: String,
      required: true,
    },
    emailObfuscated: {
      type: String,
      trim: true,
      maxlength: 255,
    },
    email: {
      type: String,
      trim: true,
      maxlength: 255,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

module.exports = mongoose.model("Owner", ownerSchema);
