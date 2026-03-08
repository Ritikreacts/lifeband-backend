const mongoose = require("mongoose");

const bandSeriesSchema = new mongoose.Schema(
  {
    prefix: {
      type: String,
      required: true,
      trim: true,
    },
    start: {
      type: Number,
      required: true,
    },
    end: {
      type: Number,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["generated", "printed"],
      required: true,
      default: "generated",
    },
    // Absolute OS path to the generated ZIP — stored for the download route.
    // Never exposed in API responses (select("-zipPath") used in list queries).
    zipPath: {
      type: String,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

module.exports = mongoose.model("BandSeries", bandSeriesSchema);
