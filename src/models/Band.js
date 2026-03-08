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
    series: {
      type: String,
      trim: true,
    },
    isRegistered: {
      type: Boolean,
      default: false,
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
