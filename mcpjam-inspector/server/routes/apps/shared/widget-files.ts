import { Hono } from "hono";
import "../../../types/hono";
import { logger } from "../../../utils/logger";

// In-memory file store for widget uploads. Lives at module scope so all
// route mounts (canonical `/api/apps/files/*` and legacy `/api/apps/chatgpt-apps/*`
// alias) share the same backing map.

interface StoredFile {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  timestamp: number;
}

const fileStore = new Map<string, StoredFile>();
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const ONE_HOUR_MS = 60 * 60 * 1000;

setInterval(
  () => {
    const now = Date.now();
    for (const [fileId, file] of fileStore.entries()) {
      if (now - file.timestamp > ONE_HOUR_MS) {
        fileStore.delete(fileId);
      }
    }
  },
  5 * 60 * 1000,
).unref();

// Magic-byte check prevents a `.exe` renamed `.png` from being stored under
// a trusted MIME. Only image/png, image/jpeg, image/webp are allowed.
function validateMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 12) return false;
  switch (mimeType) {
    case "image/png":
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      );
    case "image/jpeg":
      return buffer[0] === 0xff && buffer[1] === 0xd8;
    case "image/webp":
      return (
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
      );
    default:
      return false;
  }
}

const widgetFiles = new Hono();

widgetFiles.post("/upload-file", async (c) => {
  try {
    const { data, mimeType, fileName } = await c.req.json();

    if (!data || typeof data !== "string") {
      return c.json({ error: "Missing or invalid base64 data" }, 400);
    }
    if (!mimeType || !ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return c.json(
        {
          error: `Unsupported file type: ${mimeType}. Allowed: ${[...ALLOWED_IMAGE_TYPES].join(", ")}`,
        },
        400,
      );
    }

    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0) {
      return c.json({ error: "Empty file" }, 400);
    }
    if (buffer.length > MAX_FILE_SIZE) {
      return c.json(
        {
          error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        },
        400,
      );
    }
    if (!validateMagicBytes(buffer, mimeType)) {
      return c.json(
        { error: "File content does not match declared MIME type" },
        400,
      );
    }

    const fileId = `file_${crypto.randomUUID()}`;
    fileStore.set(fileId, {
      buffer,
      mimeType,
      fileName: fileName || "upload",
      timestamp: Date.now(),
    });

    return c.json({ fileId });
  } catch (error) {
    logger.error("Error uploading file:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      500,
    );
  }
});

widgetFiles.get("/file/:fileId", (c) => {
  const fileId = c.req.param("fileId");
  const stored = fileStore.get(fileId);
  if (!stored) {
    return c.json({ error: "File not found or expired" }, 404);
  }

  c.header("Content-Type", stored.mimeType);
  c.header("Content-Disposition", "inline");
  c.header("Cache-Control", "private, max-age=3600");
  // Allow cross-origin access so the widget iframe (127.0.0.1) can fetch.
  c.header("Access-Control-Allow-Origin", "*");
  return c.body(new Uint8Array(stored.buffer));
});

export default widgetFiles;
