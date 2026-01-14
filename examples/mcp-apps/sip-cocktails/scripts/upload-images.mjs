#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ConvexHttpClient } from "convex/browser";

const DEFAULT_DIR = "temp-images";
const SUPPORTED_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const targetDir = process.argv[2] ?? DEFAULT_DIR;
const resolvedDir = path.resolve(process.cwd(), targetDir);
const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;

if (!convexUrl) {
  console.error("Missing CONVEX_URL or VITE_CONVEX_URL in the environment.");
  process.exit(1);
}

const client = new ConvexHttpClient(convexUrl);

const guessContentType = (ext) => {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
};

const entries = await readdir(resolvedDir, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => SUPPORTED_EXTS.has(path.extname(name).toLowerCase()));

if (files.length === 0) {
  console.log(`No supported images found in ${resolvedDir}.`);
  process.exit(0);
}

console.log(`Uploading ${files.length} images from ${resolvedDir}...`);

for (const fileName of files) {
  const filePath = path.join(resolvedDir, fileName);
  const ext = path.extname(fileName).toLowerCase();
  const id = path.basename(fileName, ext);
  const bytes = new Uint8Array(await readFile(filePath));
  const contentType = guessContentType(ext);

  const uploadUrl = await client.mutation("images:generateUploadUrl", {});
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: bytes,
  });

  if (!uploadResponse.ok) {
    throw new Error(
      `Failed to upload ${fileName}: ${uploadResponse.status} ${uploadResponse.statusText}`,
    );
  }

  const { storageId } = await uploadResponse.json();
  const result = await client.mutation("images:saveImage", {
    id,
    filename: fileName,
    contentType,
    storageId,
  });

  console.log(
    `${fileName} -> image id "${id}" stored as ${result.storageId} (doc ${result.docId})`,
  );
}
