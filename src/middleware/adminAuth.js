const { verifyToken } = require("../utils/hash");

/**
 * Middleware to protect admin routes.
 * Expects a Bearer JWT in the Authorization header.
 * Attaches the decoded payload to req.admin on success.
 */
const adminAuth = (req, res, next) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ success: false, message: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = verifyToken(token);
    req.admin = decoded;
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ success: false, message: "Unauthorized: Invalid or expired token" });
  }
};

module.exports = adminAuth;
