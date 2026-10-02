// Request helpers shared by the API handler (dev middleware, `vite preview`, Vercel functions).
import { createHash, randomBytes } from "node:crypto";

/**
 * Client IP. On Vercel, the platform sets x-real-ip / x-forwarded-for itself (client-supplied
 * values are overwritten), so they are trusted only when running there (VERCEL=1).
 * Elsewhere the socket address is used and forwarding headers are ignored (they're spoofable).
 */
export function clientIp(req) {
  if (process.env.VERCEL === "1") {
    const real = String(req.headers["x-real-ip"] ?? "").trim();
    if (real) return real;
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** Non-GET requests must come from this site (or a non-browser client without Origin). */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const salt = process.env.LOG_SALT || randomBytes(16).toString("hex");

/** Short, non-reversible client id for logs — never log raw IPs. */
export function logId(value) {
  return createHash("sha256").update(salt).update(String(value)).digest("hex").slice(0, 8);
}
