const mongoose = require("mongoose");

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is not defined in environment variables");
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    console.log(`[DB] MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on("error", (err) => {
      console.error("[DB] MongoDB connection error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("[DB] MongoDB disconnected. Attempting to reconnect...");
    });

    mongoose.connection.on("reconnected", () => {
      console.log("[DB] MongoDB reconnected.");
    });
  } catch (err) {
    console.error("[DB] Failed to connect to MongoDB:", err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
