import type { AttachedFile } from "../types";
import { formatBytes } from "./util";

// Attachments are read as text in the browser and inlined into the prompt.
// Binary files (images, PDFs, Office docs) are rejected: the API integration has no
// upload/vision pipeline, so accepting them would misrepresent what the model receives.

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_FILES = 5;

const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tar|exe|dll|bin|mp[34]|wav|mov|avi|woff2?|ttf)$/i;

export async function readTextFile(file: File): Promise<AttachedFile> {
  if (BINARY_EXT.test(file.name)) throw new Error(`${file.name}: only text files are supported (code, Markdown, CSV, JSON, logs).`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} per file.`);
  const text = await file.text();
  if (text.slice(0, 4000).includes("\u0000")) throw new Error(`${file.name} looks like a binary file. Only text files are supported.`);
  return { name: file.name, size: file.size, text };
}
