const mongoose = require("mongoose");

const emergencyProfileSchema = new mongoose.Schema(
  {
    bandId: {
      type: String,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
    },
    bloodGroup: {
      type: String,
      required: true,
      trim: true,
    },
    emergencyContact: {
      type: String,
      required: true,
      trim: true,
    },
    allergies: {
      type: String,
      trim: true,
    },
    medicalConditions: {
      type: String,
      trim: true,
    },
    medications: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    updatedAt: {
      type: Date,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

module.exports = mongoose.model("EmergencyProfile", emergencyProfileSchema);
