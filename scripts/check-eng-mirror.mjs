/**
 * The eng flow (.agents/skills/eng, scripts/eng, its hook configs and the
 * commit-msg hook) is mirrored whole from mcpjam-backend, which pins the
 * same file list as "eng-flow" in convex/lib/mirrors.json. Both pins hash
 * the files the same way, so they hold the same value.
 *
 *   node scripts/check-eng-mirror.mjs                    # this side vs its pin
 *   node scripts/check-eng-mirror.mjs --backend <path>   # and vs a backend checkout
 *   node scripts/check-eng-mirror.mjs --write            # re-pin after a deliberate sync
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pinPath = resolve(root, "scripts/eng/mirror.json");
const pin = JSON.parse(readFileSync(pinPath, "utf8"));

/** The backend's normalization: quote style, trailing space and blank runs are house style. */
const normalize = (text) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/"/g, "'")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const read = (base, file) => normalize(readFileSync(resolve(base, file), "utf8"));
const content = (base) =>
  pin.files.map((file) => `--- ${file}\n${read(base, file)}`).join("\n");
const sha256 = createHash("sha256").update(content(root)).digest("hex");

if (process.argv.includes("--write")) {
  writeFileSync(pinPath, `${JSON.stringify({ ...pin, sha256 }, null, 2)}\n`);
  console.log("[check-eng-mirror] re-pinned. Commit scripts/eng/mirror.json.");
} else if (sha256 !== pin.sha256) {
  console.error(
    "[check-eng-mirror] the eng flow changed since its pin. Make the same change in mcpjam-backend (or confirm it needs none), then re-pin both: here with --write, there with `npm run check:mirrors -- --write`."
  );
  process.exitCode = 1;
}

const index = process.argv.indexOf("--backend");
if (index >= 0) {
  const backend = resolve(process.argv[index + 1] ?? "");
  const drifted = pin.files.filter((file) => {
    try {
      return read(root, file) !== read(backend, file);
    } catch {
      // Missing on the backend side counts as drift.
      return true;
    }
  });
  if (drifted.length) {
    console.error(`[check-eng-mirror] differs from ${backend}:\n  ${drifted.join("\n  ")}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`[check-eng-mirror] ${pin.files.length} files OK.`);
