import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One picker, guarded by a grep.
 *
 * BB-142 did not start as a design problem. It started with three components
 * that all let a user choose a server — `ServerGroupPicker`, an alias of it
 * re-exported under a second name, and `ServerSelectionCard` — and no rule
 * about which one a new surface should reach for. Which one you got was an
 * accident of when your screen was written. Deleting the three and writing
 * `ServerPicker` fixes today; it does not stop a fourth being written next
 * month, and nothing about writing one is difficult enough to be its own
 * deterrent.
 *
 * So this is an INVENTORY LOCK, not a proof. It finds every file that renders
 * a clickable list of servers and asserts the set is exactly the one declared
 * below. A new one fails with a pointer to `ServerPicker`; a listed one that
 * stops matching fails too, so the list cannot quietly accumulate entries for
 * surfaces that already migrated.
 *
 * SCOPE, stated rather than implied — a ratchet that overstates itself is
 * worse than none:
 *
 * - It sees `client/src/**` only. The design system's own panel lives in
 *   another package and is not scanned.
 * - It matches on SHAPE: a `.map(` whose receiver mentions "server" and whose
 *   body contains a click or checkbox affordance. A list built some other way
 *   — a `for` loop, a child component handed pre-rendered rows — passes
 *   unexamined.
 * - It cannot tell a picker from a list that merely happens to be clickable.
 *   That judgement is why each entry below carries a reason instead of just a
 *   path.
 *
 * What it does catch is the shape that actually went wrong three times: a
 * server list and its rows written inline in one file.
 */
const CLIENT_SRC = join(__dirname, "..", "..", "..");

/**
 * The files allowed to render a clickable server list, and why each one is
 * not something `ServerPicker` should have replaced.
 *
 * Adding a path here is a claim that this surface is NOT choosing a server
 * group for a project. Write the reason; a bare path tells the next reader
 * nothing about whether the exception still holds.
 */
const ALLOWED: Record<string, string> = {
  "components/hosts/server-selection-list.tsx":
    "The shared multi-select leaf (checkbox rows, no data, no popover) that " +
    "the host attachment editor renders. A control ServerPicker's own panel " +
    "is a sibling of, not a competitor to it.",

  "components/ActiveServerSelector.tsx":
    "The header's connection strip: multi-select by server NAME over runtime " +
    "state, with reconnect / hide / transport per tab and an Add Server entry. " +
    "It picks nothing that persists — there is no serverAttachmentId here — so " +
    "it is a connection panel, not a picker.",

  "components/chat-v2/chat-input.tsx":
    "KNOWN GAP, not an exemption. The `minimalMode` 'Add server' popover is a " +
    "hand-rolled picker: rows with an OAuth hint, no connection dot, no " +
    "Connect action, no tabs. It survived BB-142 only because it keys off " +
    "scenario servers rather than serverAttachmentId, so the migration's own " +
    "audit did not see it. It should move to ServerPicker.",

  "components/chat-v2/chat-input/skills/skills-popover-section.tsx":
    "Skills, not servers — it matches on `serverSkills`, the skills a server " +
    "provides. The rows select a skill.",

  "components/e2e/OAuthDebuggerE2EHarness.tsx":
    "A test harness, not a product surface. It drives the OAuth debugger from " +
    "Playwright and is not reachable in the app.",

  "components/evaluate/evals-empty-hero.tsx":
    "Not a selection at all: the cards are a shortcut that CREATES a suite " +
    "from a server. Clicking one leaves the screen.",

  "components/hosted/ScenarioHostOnboardingOverlays.tsx":
    "Authorization prompts. Each row is one server waiting on consent with an " +
    "Authorize action; nothing is being chosen from among them.",

  "components/plugins/PluginGroupCard.tsx":
    "A plugin version's declared components, listed with their setup state. " +
    "The rows open a requirement editor, they do not attach a server.",
};

/**
 * The text of the `(...)` that begins at `openIndex`, or "" when it never
 * closes. Used to read a `.map(` callback whole rather than guessing at how
 * many lines of it to look at — a row's `onClick` is routinely 30 lines below
 * the `.map(` that opens it.
 */
export function balancedCall(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return "";
}

/**
 * Does this file map a server-ish collection into something clickable?
 *
 * The receiver is read from the 60 characters BEFORE `.map(`, which is where
 * the collection is named (`servers.map`, `visibleServers.map`,
 * `pendingOAuthServers.map`). Sixty rather than the whole line because these
 * are routinely wrapped by the formatter.
 */
export function rendersClickableServerList(source: string): boolean {
  const pattern = /\.map\s*\(/g;
  for (
    let match = pattern.exec(source);
    match;
    match = pattern.exec(source)
  ) {
    const receiver = source.slice(Math.max(0, match.index - 60), match.index);
    if (!receiver.toLowerCase().includes("server")) continue;
    const body = balancedCall(source, match.index + match[0].length - 1);
    if (!body) continue;
    if (
      body.includes("onClick") ||
      body.includes("<button") ||
      body.includes("<Checkbox")
    ) {
      return true;
    }
  }
  return false;
}

function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Tests render these lists on purpose; the rule is about the app.
      if (entry !== "node_modules" && entry !== "__tests__") {
        collectTsx(full, out);
      }
      continue;
    }
    if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Posix-separated, so the allowlist reads the same on every platform. */
function repoPath(full: string): string {
  return relative(CLIENT_SRC, full).split(sep).join("/");
}

describe("one server picker", () => {
  // Walked ONCE. The sanity check below used to walk the tree a second time
  // just to count it, which is both a wasted recursive pass and two walks that
  // could in principle disagree about what they saw.
  const allTsx = collectTsx(CLIENT_SRC);
  const found = allTsx
    .filter((full) => rendersClickableServerList(readFileSync(full, "utf8")))
    .map(repoPath)
    .sort();

  it("has no clickable server list outside the declared set", () => {
    const undeclared = found.filter((path) => !(path in ALLOWED));
    expect(
      undeclared,
      undeclared.length === 0
        ? ""
        : `These files render a clickable list of servers and are not declared in ALLOWED:\n` +
          undeclared.map((p) => `  - ${p}`).join("\n") +
          `\n\nIf the surface lets someone choose a server or a server group for a ` +
          `project, render <ServerPicker> instead — that is what BB-142 was for. ` +
          `If it is something else (authorizing, connecting, a shortcut that ` +
          `navigates away), add it to ALLOWED in this file with the reason.`,
    ).toEqual([]);
  });

  it("declares nothing that has already stopped matching", () => {
    // A surface that migrates to ServerPicker stops matching, and its entry
    // has to go with it — otherwise the list slowly becomes a record of what
    // was once true, which is the state the three pickers were discovered in.
    const stale = Object.keys(ALLOWED)
      .filter((path) => !found.includes(path))
      .sort();
    expect(
      stale,
      stale.length === 0
        ? ""
        : `These paths are declared in ALLOWED but no longer render a clickable ` +
          `server list (migrated, renamed, or deleted):\n` +
          stale.map((p) => `  - ${p}`).join("\n") +
          `\n\nDelete the entry.`,
    ).toEqual([]);
  });

  it("is looking at a real tree, and finding the surfaces we know exist", () => {
    // Without this the two assertions above both pass on an empty scan — a
    // broken path or an over-tight regex would read as a clean repo.
    expect(allTsx.length).toBeGreaterThan(100);
    expect(found).toContain("components/ActiveServerSelector.tsx");
  });
});
