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

/**
 * The methods the adapter actually dispatches on, read from its own source so
 * this file cannot drift into a stale second copy of the list.
 */
const USED = (() => {
  const protocolPath = new URL(
    "../../mcpjam-inspector/server/utils/harness/codex-appserver/bridge/app-server-protocol.ts",
    import.meta.url
  );
  let source = "";
  try {
    source = readFileSync(protocolPath, "utf8");
  } catch {
    // Unreadable (moved, or the diff run standalone): treat every removal as
    // significant rather than silently narrowing the check.
    return { has: () => true };
  }
  // Named individually, NOT matched as a family. A guard on the total count
  // is no guard at all: if one export changed shape the regex would skip it,
  // the other two would still make the set non-empty, and every removal from
  // the unparsed category would be waved through as insignificant — silently,
  // which is the one outcome this file exists to prevent.
  const EXPECTED = [
    "USED_CLIENT_METHODS",
    "USED_SERVER_REQUESTS",
    "USED_NOTIFICATIONS",
  ];
  const names = new Set();
  const missed = [];
  for (const exported of EXPECTED) {
    const block = source.match(
      new RegExp(`export const ${exported} = \\[([\\s\\S]*?)\\] as const;`)
    );
    const quoted = block ? [...block[1].matchAll(/"([^"]+)"/g)] : [];
    if (!quoted.length) {
      missed.push(exported);
      continue;
    }
    for (const match of quoted) names.add(match[1]);
  }
  if (missed.length) {
    process.stderr.write(
      `warning: could not read ${missed.join(", ")} from app-server-protocol.ts; ` +
        "treating every removal as significant\n"
    );
    return { has: () => true };
  }
  return names;
})();

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
  // Only a method the ADAPTER actually speaks is fatal. Upstream removes
  // methods this adapter never called (there are ~95 client methods and it uses
  // a handful), and failing the diff on those trained the reader to ignore it —
  // which is how a removal that does matter would slip through. Unused removals
  // stay in the report, just not as an error.
  const lostAndUsed = lost.filter((m) => USED.has(m));
  if (lostAndUsed.length) removedAnything = true;
  out += `${file}: ${before.size} -> ${after.size}\n`;
  out += bullets("added", gained);
  out += bullets("REMOVED", lost);
  out += bullets("REMOVED AND USED BY THE ADAPTER", lostAndUsed);
}

process.stdout.write(out);
if (removedAnything) {
  process.stderr.write(
    "\nA method the adapter SPEAKS was removed upstream. Its schema-snapshot test will fail until the adapter is updated and the snapshot re-pinned.\n"
  );
  process.exit(1);
}
