const mongoose = require("mongoose");

const bandSchema = new mongoose.Schema(
  {
    bandId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    secureToken: {
      type: String,
      unique: true,
      index: true,
      sparse: true, // Allows null/missing for legacy, but ensures uniqueness if present
    },
    series: {
      type: String,
      trim: true,
    },
    isRegistered: {
      type: Boolean,
      default: false,
    },
    scanCount: {
      type: Number,
      default: 0,
    },
    registeredAt: {
      type: Date,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

module.exports = mongoose.model("Band", bandSchema);
