const mongoose = require("mongoose");

const ownerSchema = new mongoose.Schema(
  {
    bandId: {
      type: String,
      unique: true,
      index: true,
      trim: true,
    },
    phoneHash: {
      type: String,
      required: true,
    },
    phoneLast4: {
      type: String,
      trim: true,
      maxlength: 4,
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
