// Response headers for every page and API response. Applied by server.ts in production (AI Studio /
// Cloud Run, `npm start`) and by vercel.json on Vercel. server/api.test.mjs checks vercel.json stays in sync.
//
// KaTeX output uses inline style attributes, hence 'unsafe-inline' for styles only; scripts stay 'self'.
// Framing is allowed only for Google AI Studio, which shows the app in an iframe (so no X-Frame-Options,
// which can't express an allowlist).
export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self' https://aistudio.google.com",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
