/**
 * What the adversarial review checks a UI change against: the design system
 * (DESIGN.md from the default branch, never the PR's copy) and the product or
 * design spec the PR names in its "Task, spec and plan" section.
 *
 * The spec is read from the PR description: the `Spec:` line, the user story
 * and the acceptance criteria. A spec the `Spec:` line names as a file in this
 * repository is read from the PR head through git. A spec behind an external
 * link (Kestral, Figma, a doc) cannot be read from CI, so the review says so
 * and falls back to the description. Everything here is data for the review;
 * nothing is run.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DESIGN_PATH = fileURLToPath(new URL("../../DESIGN.md", import.meta.url));
const MAX_SPEC_DOCS = 2;
const MAX_SPEC_BYTES = 60_000;
const MAX_SECTION_BYTES = 8_000;

/** Files a person sees: components, styles and pages, not their tests or stories. */
export function isUiPath(path) {
  return /\.(tsx|jsx|css|html)$/.test(path) &&
    !/(^|\/)__tests__\/|\.(test|spec|stories)\.[jt]sx?$/.test(path);
}

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "").trim();

/** The value of a `- **Label:**` line, continued until the next such line or heading. */
function fieldValue(lines, label) {
  const start = lines.findIndex((line) => new RegExp(`^[-*]\\s*\\*\\*${label}:\\*\\*`, "i").test(line));
  if (start === -1) return "";
  const parts = [lines[start].replace(/^[-*]\s*\*\*[^*]+:\*\*/, "")];
  for (const line of lines.slice(start + 1)) {
    if (/^[-*]\s*\*\*[^*]+:\*\*/.test(line) || /^#{1,6}\s/.test(line)) break;
    parts.push(line);
  }
  return stripComments(parts.join("\n"));
}

/** A `## heading` section's text, up to the next heading of the same or a higher level. */
function section(lines, heading) {
  const start = lines.findIndex((line) => new RegExp(`^(#{2,3})\\s+${heading}\\s*$`, "i").test(line));
  if (start === -1) return "";
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((line, index) => index > start && /^(#+)\s/.test(line) &&
    line.match(/^#+/)[0].length <= level);
  return stripComments(lines.slice(start + 1, end === -1 ? undefined : end).join("\n")).slice(0, MAX_SECTION_BYTES);
}

/** The spec fields of a PR description. Placeholder-only fields come back empty. */
export function specFromBody(body) {
  const lines = (body ?? "").split(/\r?\n/);
  // The template's own skeleton ("**As a** ...,", "- [ ] ...") is not a spec.
  const clean = (value) => value.replace(/\*\*(As an?|I want|so that)\*\*|- \[[ x]\]|\.\.\.|[,*\s-]/gi, "") ? value : "";
  return {
    spec: fieldValue(lines, "Spec"),
    userStory: clean(section(lines, "User story").replace(/### Acceptance criteria[\s\S]*/i, "").trim()),
    acceptance: clean(section(lines, "Acceptance criteria")),
  };
}

/**
 * Repository paths a `Spec:` value points at: a relative Markdown path, or a
 * GitHub blob URL into this repository. Anything else is an external link.
 */
export function specReferences(spec, repo) {
  const paths = new Set();
  const external = [];
  const blob = new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/blob/[^/]+/([^#?]+)`, "i");
  const urls = (spec.match(/https?:\/\/[^\s)>\]]+/g) ?? []).map((url) => url.replace(/[.,;:]+$/, ""));
  for (const url of urls) {
    const match = blob.exec(url);
    if (match) paths.add(decodeURIComponent(match[1]));
    else external.push(url);
  }
  const withoutUrls = spec.replace(/https?:\/\/[^\s)>\]]+/g, " ");
  for (const match of withoutUrls.matchAll(/(?:^|[\s(`[])((?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|txt))\b/g)) {
    const path = match[1].replace(/^\.\//, "");
    if (!path.startsWith("/") && !path.includes("..")) paths.add(path);
  }
  return { paths: [...paths].slice(0, MAX_SPEC_DOCS), external };
}

/**
 * The design and spec context for the review, or null when the PR changes no
 * UI file. `readFile(path)` returns PR-head content or null; `readDesign()`
 * returns the default branch's DESIGN.md.
 */
export function designContext({ changedPaths, body, repo, readFile, readDesign = () => readFileSync(DESIGN_PATH, "utf8") }) {
  const uiFiles = changedPaths.filter(isUiPath);
  if (uiFiles.length === 0) return null;
  const notes = [];
  let design = null;
  try {
    design = readDesign();
  } catch (error) {
    notes.push(`DESIGN.md could not be read (${error.message}), so the UI was not checked against the design system.`);
  }
  const fields = specFromBody(body);
  const { paths, external } = specReferences(fields.spec, repo);
  const documents = [];
  for (const path of paths) {
    const content = readFile(path);
    if (content === null) notes.push(`The spec \`${path}\` named in the description is not in the PR head.`);
    else documents.push({ path, content: content.slice(0, MAX_SPEC_BYTES) });
  }
  if (external.length && documents.length === 0) {
    notes.push(`The spec is behind a link CI cannot read (${external.join(", ")}). ` +
      "The UI was checked against the description's user story and acceptance criteria instead.");
  }
  const hasSpec = documents.length > 0 || fields.userStory || fields.acceptance;
  if (!hasSpec) notes.push("The description has no spec, user story or acceptance criteria, so the UI was checked against the design system only.");
  return { uiFiles, design, spec: { ...fields, documents }, notes };
}
