const mongoose = require("mongoose");

const adminUserSchema = new mongoose.Schema(
  {
    emailHash: {
      type: String,
      required: true,
      unique: true,
    },
    passwordHash: {
      type: String,
      required: true,
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

module.exports = mongoose.model("AdminUser", adminUserSchema);
