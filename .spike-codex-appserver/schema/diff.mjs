// Diff two pinned codex app-server schema snapshots.
//
// Two layers, because they answer different questions:
//   1. MANIFEST digests — did ANY generated payload change (incl. files we do
//      not commit in full)?
//   2. Union method sets — did a method / notification / server request the
//      adapter dispatches on appear or DISAPPEAR? A removal is the breaking
//      case; additions are informational.
//
// Usage: node diff.mjs <old-snapshot-dir> <new-snapshot-dir>
// Exit 1 if anything the adapter depends on was removed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [oldDir, newDir] = process.argv.slice(2);
if (!oldDir || !newDir) {
  process.stderr.write("usage: diff.mjs <old-dir> <new-dir>\n");
  process.exit(2);
}

const read = (dir, file) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const methods = (schema) =>
  new Set(
    (schema.oneOf ?? schema.anyOf ?? []).map(
      (variant) =>
        variant.properties?.method?.enum?.[0] ??
        variant.properties?.method?.const ??
        "<unnamed>"
    )
  );
const bullets = (label, values) =>
  values.length ? `  ${label}: ${values.join(", ")}\n` : "";

let removedAnything = false;
let out = "";

const oldManifest = read(oldDir, "MANIFEST.json");
const newManifest = read(newDir, "MANIFEST.json");
out += `codex ${oldManifest.codexVersion} -> ${newManifest.codexVersion}\n\n`;

const oldFiles = oldManifest.files;
const newFiles = newManifest.files;
const added = Object.keys(newFiles).filter((f) => !(f in oldFiles));
const removed = Object.keys(oldFiles).filter((f) => !(f in newFiles));
const changed = Object.keys(newFiles).filter(
  (f) => f in oldFiles && oldFiles[f] !== newFiles[f]
);
out += `payload files: +${added.length} -${removed.length} ~${changed.length}\n`;
out += bullets("added", added);
out += bullets("removed", removed);
out += bullets("changed", changed.slice(0, 40));
if (changed.length > 40) out += `  ... and ${changed.length - 40} more\n`;
out += "\n";

for (const file of [
  "ClientRequest.json",
  "ServerRequest.json",
  "ServerNotification.json",
  "ClientNotification.json",
]) {
  const before = methods(read(oldDir, file));
  const after = methods(read(newDir, file));
  const gained = [...after].filter((m) => !before.has(m));
  const lost = [...before].filter((m) => !after.has(m));
  if (lost.length) removedAnything = true;
  out += `${file}: ${before.size} -> ${after.size}\n`;
  out += bullets("added", gained);
  out += bullets("REMOVED", lost);
}

process.stdout.write(out);
if (removedAnything) {
  process.stderr.write(
    "\nA method was REMOVED upstream. The adapter's schema-snapshot test will fail until it is re-pinned.\n"
  );
  process.exit(1);
}
