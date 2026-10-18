/**
 * Pins the eng flow tooling, which mcpjam-backend owns and this repo copies.
 * Editing a pinned file without re-pinning fails `check:mirrors`: the failure
 * asks whoever changed this side to make the same change in the backend, which
 * is the canonical copy, and to record that they did by re-pinning.
 *
 *   node scripts/check-eng-mirror.mjs                    # hash mode, CI-safe
 *   node scripts/check-eng-mirror.mjs --write            # re-pin after a sync
 *   node scripts/check-eng-mirror.mjs --upstream <backend checkout>   # real diff
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PINS = join(ROOT, "scripts/eng-mirror.json");

/** Paths shared with the backend, file or folder. Repo-specific files stay out. */
export const MIRRORED = [
  "scripts/eng",
  "scripts/git-hooks/prepare-commit-msg",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  ".agents/skills/eng",
  ".agents/skills/grilling",
  ".agents/skills/codebase-design",
  ".agents/skills/tdd",
  ".agents/skills/diagnosing-bugs",
  ".agents/skills/code-review",
  ".agents/skills/adversarial-reviewer",
  ".agents/skills/engineering-writing",
];

function filesUnder(root, path) {
  const full = join(root, path);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full, { recursive: true })
    .map((entry) => join(path, String(entry)))
    .filter((entry) => statSync(join(root, entry)).isFile())
    .map((entry) => relative(root, join(root, entry)).split("\\").join("/"))
    .sort();
}

export function hashFile(root, path) {
  const text = readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex");
}

export function currentPins(root = ROOT) {
  return Object.fromEntries(
    MIRRORED.flatMap((path) => filesUnder(root, path)).map((path) => [path, hashFile(root, path)]),
  );
}

function main(args) {
  const now = currentPins();
  if (args.includes("--write")) {
    writeFileSync(PINS, `${JSON.stringify({ files: now }, null, 2)}\n`);
    console.log(`Pinned ${Object.keys(now).length} eng tooling files.`);
    return 0;
  }
  const pinned = JSON.parse(readFileSync(PINS, "utf8")).files;
  const changed = [...new Set([...Object.keys(now), ...Object.keys(pinned)])].filter(
    (path) => now[path] !== pinned[path],
  );
  const upstreamAt = args.indexOf("--upstream");
  const drift = upstreamAt >= 0
    ? Object.keys(now).filter((path) => {
        const other = resolve(args[upstreamAt + 1] ?? "");
        return !existsSync(join(other, path)) || hashFile(other, path) !== now[path];
      })
    : [];
  if (changed.length) {
    console.error(
      `Eng tooling changed without a re-pin:\n${changed.map((p) => `  ${p}`).join("\n")}\n` +
        "mcpjam-backend holds the canonical copy. Make the same change there, then re-pin:\n" +
        "  node scripts/check-eng-mirror.mjs --write",
    );
  }
  if (drift.length) {
    console.error(`Differs from the backend checkout:\n${drift.map((p) => `  ${p}`).join("\n")}`);
  }
  if (changed.length || drift.length) return 1;
  console.log("Eng tooling mirror verified.");
  return 0;
}

if (process.argv[1] === import.meta.filename) process.exitCode = main(process.argv.slice(2));
