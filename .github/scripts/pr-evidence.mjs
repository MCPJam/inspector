// Reads a PR's "Screenshots and recordings" section and names evidence a
// reviewer cannot use: none at all on a PR that changes what users see, image
// links hosted outside GitHub, and screenshots taken at a commit that does not
// contain the head. Advisory only; .github/workflows/pr-evidence.yml posts the result
// as one comment and never fails.

import { isMeasuredFile } from "../../scripts/slop/rules.mjs";
import { isUiFile } from "../../scripts/slop/ui-strings.mjs";

export const MARKER = "<!-- pr-evidence-advisory -->";
const HEADING = /^##\s+Screenshots and recordings\s*$/i;

/**
 * The slop ratchet's own definitions: source in a package whose strings reach
 * a screen, minus tests, stories and generated files. Stylesheets and
 * server error text are not covered.
 */
export function isUserVisible(path) {
  return isUiFile(path) && isMeasuredFile(path);
}

/** The section's text with template comments removed, or null if absent. */
export function evidenceSection(body) {
  const lines = (body ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
  return stripComments(lines.slice(start + 1, end === -1 ? undefined : end).join("\n")).trim();
}

// Repeated until stable: one pass over "<!<!---->--" leaves "<!--" behind.
function stripComments(text) {
  let prev;
  do {
    prev = text;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
  } while (text !== prev);
  return text;
}

// The template's empty Before/After table, so an untouched one reads as empty.
const PLACEHOLDER_ROW = /^\|(?:[\s|:-]*|\s*Before\s*\|\s*After\s*\|)$/i;

/** "empty", "none" or null when the section holds something. */
export function emptiness(section) {
  if (section === null) return "empty";
  const text = section
    .split("\n")
    .filter((line) => !PLACEHOLDER_ROW.test(line.trim()))
    .join("\n")
    .trim();
  if (!text) return "empty";
  // The template's opt-out. A reason does not clear it: most "None" answers
  // on user-visible source in the measured sample hid a visible change.
  if (/^none\b/i.test(text)) return "none";
  return null;
}

const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)(?:[?#]\S*)?$/i;

/** Every image or video reference in the body: markdown, HTML, or a bare media path. */
export function mediaRefs(body) {
  const text = stripComments(body ?? "");
  const refs = new Set();
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) refs.add(m[1]);
  for (const m of text.matchAll(/<(?:img|video|source)\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    refs.add(m[1]);
  }
  // A bare reference starts a token, so "0/2/4px" in alt text is not a path.
  for (const m of text.matchAll(/(?<=^|[\s("'`=])(?:https?:\/\/|file:|~\/|\/|[A-Za-z]:[\\/])[^\s()[\]"'<>`|]+/gm)) {
    if (MEDIA_EXT.test(m[0]) || /presigned_proxy/i.test(m[0])) refs.add(m[0]);
  }
  return [...refs];
}

/**
 * Links a reviewer cannot rely on: absolute local paths and file: URLs, which
 * open only on the author's machine, and Devin's presigned proxy, which serves
 * a private attachment for as long as Devin keeps it.
 */
export function isUnreachable(ref) {
  return (
    /^https?:\/\/app\.devin\.ai\//i.test(ref) ||
    /presigned_proxy/i.test(ref) ||
    /^file:/i.test(ref) ||
    /^(?:\/home\/|\/Users\/|\/tmp\/|~\/)/.test(ref) ||
    /^[A-Za-z]:[\\/]/.test(ref)
  );
}

/**
 * Commit SHAs the section names. URLs are dropped first because upload and
 * Chromatic links carry hex ids that are not commits; a `/commit/<sha>` link
 * still counts.
 */
export function namedShas(section) {
  if (!section) return [];
  const shas = new Set();
  for (const m of section.matchAll(/\/commits?\/([0-9a-f]{7,40})\b/gi)) {
    shas.add(m[1].toLowerCase());
  }
  const prose = section.replace(/https?:\/\/\S+|\]\([^)]*\)|\bsrc\s*=\s*["'][^"']*["']/gi, " ");
  for (const m of prose.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
    // A hex word needs a digit and a letter to read as a SHA, not "decade" or "1234567".
    if (/\d/.test(m[0]) && /[a-f]/i.test(m[0])) shas.add(m[0].toLowerCase());
  }
  return [...shas];
}

/** Why a PR is skipped, or null. */
export function exemption({ labels = [], author }) {
  if (author === "dependabot[bot]") return "Dependabot";
  if (labels.includes("mechanical")) return "labelled mechanical";
  return null;
}

/**
 * The three rules. `files` are the PR's changed paths, old names included for
 * renames. `compare(sha)` returns GitHub's compare status of the head against
 * `sha` ("ahead", "behind", "identical", "diverged"), or null when `sha` is
 * not a commit in this repository, such as a backend SHA in the QA notes.
 * Returns `{ rule, message }` per hit, in rule order.
 */
export async function evaluate({ body, files, headSha, compare }) {
  const findings = [];
  const section = evidenceSection(body);

  const visible = files.filter(isUserVisible);
  const state = emptiness(section);
  if (visible.length && state) {
    const shown = visible.slice(0, 5).map((f) => `\`${f}\``).join(", ");
    const more = visible.length > 5 ? ` and ${visible.length - 5} more` : "";
    findings.push({
      rule: "missing",
      message:
        `This PR changes user-visible source (${shown}${more}) but ` +
        (state === "none"
          ? `"Screenshots and recordings" says None.`
          : `"Screenshots and recordings" is empty or still the template placeholder.`) +
        " Add a before and after of the screen it changes. If no screen changes, ignore this note.",
    });
  }

  // The query string is dropped: a presigned token is long and adds nothing.
  const unreachable = [
    ...new Set(mediaRefs(body).filter(isUnreachable).map((r) => r.split("?")[0])),
  ];
  if (unreachable.length) {
    findings.push({
      rule: "unreachable",
      message:
        "Some images or recordings are not hosted by GitHub: " +
        unreachable.map((r) => `\`${r}\``).join(", ") +
        ". A local path never opens for a reviewer, and a Devin presigned link " +
        "lasts only as long as that private attachment does. Drag the files " +
        "into the description so GitHub hosts them.",
    });
  }

  const stale = await staleShas(namedShas(section), headSha.toLowerCase(), compare);
  if (stale.length) {
    findings.push({
      rule: "stale",
      message:
        `The evidence names ${stale.map((s) => `\`${s}\``).join(", ")}, ` +
        `which does not contain the head \`${headSha.slice(0, 7)}\`. ` +
        "Recapture it at the head commit, or say why the screen is the same.",
    });
  }
  return findings;
}

/**
 * The named SHAs that predate the head or sit beside it, or none when any
 * named SHA is the head or contains it. A stacked PR's QA often runs at the
 * top of the stack, a descendant of this head, and that evidence covers it.
 */
async function staleShas(shas, head, compare) {
  if (!shas.length || shas.some((sha) => head.startsWith(sha))) return [];
  const statuses = await Promise.all(shas.map((sha) => compare(sha)));
  if (statuses.some((s) => s === "behind" || s === "identical")) return [];
  return shas.filter((_, i) => statuses[i] === "ahead" || statuses[i] === "diverged");
}

/** The comment body for a list of findings; a one-liner once they clear. */
export function commentBody(findings) {
  if (!findings.length) return `${MARKER}\n✅ Screenshots and recordings look usable.`;
  return [
    MARKER,
    "**Screenshots and recordings**",
    "",
    "This is advisory. It does not block the merge.",
    "",
    ...findings.map((f) => `- ${f.message}`),
  ].join("\n");
}
