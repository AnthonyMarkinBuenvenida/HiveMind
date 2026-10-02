// Vercel function for /api/chat — all logic lives in server/api.mjs (shared with local dev).
import { handleApi } from "../server/api.mjs";

export default async function handler(req, res) {
  await handleApi(req, res);
}
