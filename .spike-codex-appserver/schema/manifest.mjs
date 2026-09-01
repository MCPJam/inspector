// Emit MANIFEST.json for a generated codex app-server schema directory.
// Every generated file is hashed so a bump that changes a payload we did not
// commit in full is still caught by `diff.mjs`.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, codexVersion] = process.argv.slice(2);
if (!dir || !codexVersion) {
  process.stderr.write("usage: manifest.mjs <generated-dir> <codex-version>\n");
  process.exit(2);
}

const files = {};
const walk = (abs, prefix) => {
  const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const next = join(abs, entry.name);
    if (entry.isDirectory()) walk(next, rel);
    else
      files[rel] = createHash("sha256").update(readFileSync(next)).digest("hex");
  }
};
walk(dir, "");

process.stdout.write(
  `${JSON.stringify(
    {
      codexVersion,
      generatedBy: "codex app-server generate-json-schema --out <dir>",
      fileCount: Object.keys(files).length,
      note: "sha256 of every generated file. The four union files beside this manifest are committed in full; the rest are hash-only so drift is still detectable without carrying 3.8 MB of JSON.",
      files,
    },
    null,
    2,
  )}\n`,
);
