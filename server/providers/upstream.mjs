// Shared by the provider adapters (gemini.mjs, openrouter.mjs). An adapter throws UpstreamError
// for any failure the provider reported; server/api.mjs turns it into a user-readable message.

export class UpstreamError extends Error {
  /**
   * @param {number} status  HTTP status the provider reported (0 when unknown)
   * @param {string} detail  the provider's own message, safe to show (never contains the key)
   * @param {"midstream"} [kind] "midstream": the stream failed without a usable status
   */
  constructor(status, detail, kind) {
    super(detail || `Upstream error ${status}`);
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

/** The provider's message out of a JSON error body ({ error: { message, metadata: { raw } } } or similar). */
export function errorDetail(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error ?? j;
    const raw = typeof e.metadata?.raw === "string" ? e.metadata.raw : "";
    return String(raw || e.message || j.detail || j.title || "").slice(0, 300);
  } catch {
    return String(text ?? "").trim().slice(0, 300);
  }
}
