/**
 * Builds the SEP-2640 skills bundle a server serves.
 *
 * The worker has no filesystem, so the skills it serves must be inlined at
 * build time — the same shape as `bundle-mcp-app-html.mjs`, which inlines the
 * MCP Apps HTML. What is inlined here is more than text: each skill arrives as
 * a complete `skills/list` entry, manifest and digests included, so the request
 * handlers become literal returns and nothing is hashed per request.
 *
 * ## Three rules, each preventing a self-inflicted refusal
 *
 * 1. **Parse with the SDK's `splitSkillMarkdown`, never gray-matter.** A host
 *    re-parses the fetched SKILL.md with that exact function and compares the
 *    result field-by-field against the frontmatter we advertise. A second YAML
 *    parser here is a `frontmatter_drift` generator: the two would disagree on
 *    some edge (a date, a `~`, an implicit type) and our own skill would be
 *    refused by our own host.
 *
 * 2. **Digest and size the WHOLE file, never the body.** `verifySkillMarkdown`
 *    hashes the complete markdown before splitting it. Digesting the body is
 *    the easy mistake, because the splitter hands you one.
 *
 * 3. **Gate on `checkSkillIdentity` and on the draft's limits, and FAIL the
 *    build.** A server that publishes a skill its own host would refuse has
 *    shipped a bug to everyone else's host too. This gate has already earned
 *    its keep: it is what caught `explore-to-sdk-evals` having no parseable
 *    frontmatter at all.
 *
 * The skill roots are an EXPLICIT list, never a glob. `find . -name SKILL.md`
 * matches 30+ paths in this repo because `worktrees/` holds full checkouts, and
 * a glob would bundle six stale copies of `mcp-inspector`.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MAX_SKILL_RESOURCE_ENTRIES,
  MAX_SKILL_TOTAL_BYTES,
  canonicalSkillJson,
  checkSkillIdentity,
  splitSkillMarkdown,
} from "@mcpjam/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "../..");

/**
 * The authority segment of every URI we mint.
 *
 * It carries NO semantics — the draft is explicit that the first path segment
 * merely occupies the authority position by RFC 3986 mechanics, and that
 * clients MUST NOT resolve it. It is a namespace label, not a host.
 */
const URI_AUTHORITY = "mcpjam";

/**
 * The worker's catalog: the eval-authoring skills.
 *
 * The honest rationale, since an earlier version of this comment overstated it.
 * None of these three teaches THIS server's tools (`create_eval_suite`,
 * `run_eval_suite`, …) — they teach authoring the eval files and suites those
 * tools then operate on. That is the adjacency: a caller here is working on
 * evals, and these are the skills about evals.
 *
 * `mcp-inspector` is excluded on a narrower ground than "it mentions the CLI":
 * its whole subject is interpreting probe / doctor / OAuth / conformance
 * output, and this server exposes none of those tools, so there is nothing here
 * for it to interpret. `mcpjam-eval-import` does end in a CLI command and is
 * served by BOTH venues, deliberately — it spans the two surfaces, producing a
 * suite the platform tools run.
 */
export const WORKER_SKILL_ROOTS = [
  // The one skill here that teaches THIS server's tools rather than how to
  // author eval files elsewhere. Everything below it is about writing evals;
  // this is about running them through the 22 eval tools the worker exposes.
  "skills/run-mcpjam-evals",
  "skills/mcpjam-eval-import",
  "sdk/skills/create-mcp-eval",
  "sdk/skills/explore-to-sdk-evals",
];

/** Files that are never part of a skill. */
const IGNORED_BASENAMES = new Set([".DS_Store"]);

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (IGNORED_BASENAMES.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listFiles(abs));
    } else {
      out.push(abs);
    }
  }
  return out;
}

function sha256(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

class SkillBundleError extends Error {}

/**
 * Paths whose values JSON cannot carry faithfully.
 *
 * `NaN`/`Infinity` become `null`, a `Date` becomes a string, and `undefined`
 * disappears from an object — each one a value the host would parse out of the
 * SKILL.md and fail to match against what we advertised. The YAML `core` schema
 * can produce the first (`.nan`, `.inf`); the others are defensive.
 */
function jsonUnsafePaths(value, path = "frontmatter") {
  if (typeof value === "number" && !Number.isFinite(value)) return [path];
  if (value instanceof Date) return [path];
  if (value === undefined) return [path];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => jsonUnsafePaths(item, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      jsonUnsafePaths(item, `${path}.${key}`)
    );
  }
  return [];
}


/**
 * Reads one skill directory into a `skills/list` entry plus its file contents.
 *
 * Throws rather than warning. A skill that cannot be published correctly must
 * not be published at all, and a warning in a build log is how it would be.
 */
function readSkill(root) {
  const absRoot = join(REPO_ROOT, root);
  const name = root.split("/").pop();
  const skillUri = `skill://${URI_AUTHORITY}/${name}/SKILL.md`;

  const markdownPath = join(absRoot, "SKILL.md");
  const markdownBytes = readFileSync(markdownPath);
  const markdown = markdownBytes.toString("utf8");

  const { frontmatter } = splitSkillMarkdown(markdown);
  const identity = checkSkillIdentity(skillUri, frontmatter);
  if (!identity.ok) {
    throw new SkillBundleError(
      `${root}/SKILL.md fails the SEP-2640 identity check (${identity.reason}` +
        (identity.expected !== undefined
          ? `, expected "${identity.expected}", got "${identity.actual}"`
          : "") +
        `). MCPJam's own host would refuse this skill; fix the file rather than the gate.`
    );
  }

  // The frontmatter travels as JSON. A round-trip comparison would be
  // TAUTOLOGICAL — `canonicalSkillJson` is itself JSON.stringify-based, so a
  // value JSON cannot represent normalizes identically on both sides and the
  // check could never fire. Inspect the values instead.
  const offending = jsonUnsafePaths(frontmatter);
  if (offending.length > 0) {
    throw new SkillBundleError(
      `${root}/SKILL.md has frontmatter JSON cannot carry faithfully at ${offending.join(", ")}. ` +
        `The advertised value would differ from what a host parses out of the file, which it reports as frontmatter drift — our bug, surfaced as the server's. Use scalar YAML.`
    );
  }

  const files = [];
  for (const abs of listFiles(absRoot)) {
    const rel = relative(absRoot, abs).split(sep).join("/");
    const bytes = readFileSync(abs);
    files.push({
      uri:
        rel === "SKILL.md"
          ? skillUri
          : `skill://${URI_AUTHORITY}/${name}/${rel}`,
      digest: sha256(bytes),
      // The draft requires `size`, and defines a length mismatch as a
      // verification failure equivalent to a digest mismatch. It is the byte
      // length, not the character count — a non-ASCII skill would differ.
      size: bytes.byteLength,
      text: bytes.toString("utf8"),
    });
  }

  if (!files.some((file) => file.uri === skillUri)) {
    throw new SkillBundleError(
      `${root} has no SKILL.md in its manifest, which a host refuses as unlisted_resource.`
    );
  }
  if (files.length > MAX_SKILL_RESOURCE_ENTRIES) {
    throw new SkillBundleError(
      `${root} has ${files.length} files, over the ${MAX_SKILL_RESOURCE_ENTRIES}-entry per-skill limit.`
    );
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
    throw new SkillBundleError(
      `${root} totals ${totalBytes} bytes, over the ${MAX_SKILL_TOTAL_BYTES}-byte per-skill limit.`
    );
  }

  return {
    uri: skillUri,
    name: identity.name,
    frontmatter,
    resources: files.map(({ uri, digest, size }) => ({ uri, digest, size })),
    files: files.map(({ uri, text }) => ({ uri, text })),
  };
}

/**
 * Renders the generated module.
 *
 * Pure — it returns the text rather than writing it, so the drift test can
 * regenerate in memory and compare against the committed file without touching
 * the working tree.
 */
export function buildSkillsBundle(roots = WORKER_SKILL_ROOTS) {
  const skills = roots.map(readSkill);

  const entries = skills.map((skill) => ({
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: skill.resources,
  }));
  const contents = {};
  for (const skill of skills) {
    for (const file of skill.files) {
      if (contents[file.uri] !== undefined) {
        throw new SkillBundleError(
          `two skills claim the resource URI ${file.uri}; a manifest URI must be unique across the catalog.`
        );
      }
      contents[file.uri] = file.text;
    }
  }

  return `// This file is auto-generated by scripts/generate-skills-bundle.mjs
// Do not edit directly — edit the SKILL.md sources and regenerate.
//
// Digests and sizes are computed at BUILD time so the request handlers are
// literal returns: nothing is hashed per request, which matters on a worker
// with a CPU budget.

/** One file in a skill's manifest (SEP-2640 \`{uri, digest, size}\`). */
export interface SkillsBundleResource {
  uri: string;
  digest: string;
  size: number;
}

/** A \`skills/list\` / \`skills/get\` entry, ready to serve verbatim. */
export interface SkillsBundleEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: SkillsBundleResource[];
}

export const SKILLS_BUNDLE_ENTRIES: SkillsBundleEntry[] = ${JSON.stringify(entries, null, 2)};

/** Resource URI → file text, for \`resources/read\`. */
export const SKILLS_BUNDLE_CONTENTS: Record<string, string> = ${JSON.stringify(contents, null, 2)};
`;
}

const OUTPUT_TS_PATH = join(__dirname, "../src/generated/SkillsBundle.generated.ts");

export function generateSkillsBundle() {
  const output = buildSkillsBundle();
  mkdirSync(dirname(OUTPUT_TS_PATH), { recursive: true });
  writeFileSync(OUTPUT_TS_PATH, output);
  return output;
}

export function generateSkillsBundlePlugin() {
  return {
    name: "mcpjam-generate-skills-bundle",
    closeBundle() {
      generateSkillsBundle();
    },
  };
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  generateSkillsBundle();
}
