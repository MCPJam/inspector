import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * One picker, guarded by the compiler.
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
 * Read through `typescript`, already a dependency here, rather than by
 * scanning text. The hand-written version balanced parentheses over raw
 * source, and every construct that can hold one lied to it: a `)` in a
 * comment or a string ended the callback early, a nested template literal
 * ended it at the wrong backtick and blanked the rest of the file, a `//` in
 * JSX text ate the row below it, and regex literals were documented as
 * unfixable. Each of those was a silent MISS — a picker the lock reported as
 * clean. The parser has no such cases.
 *
 * SCOPE, stated rather than implied:
 *
 * - It sees `client/src/**` only. The design system's own panel lives in
 *   another package and is not scanned.
 * - It matches on SHAPE: a `.map(` whose receiver mentions "server", holding
 *   a click or checkbox affordance. A list built some other way — a `for`
 *   loop, a child component handed pre-rendered rows — passes unexamined.
 * - It cannot tell a picker from a list that merely happens to be clickable.
 *   That judgement is why each entry below carries a reason, not just a path.
 */
const CLIENT_SRC = join(__dirname, "..", "..", "..");

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
 * Does this file map a server-ish collection into something clickable?
 *
 * Walked as a tree: the `.map(` call node has an exact extent, so there is
 * nothing to balance and nothing for a comment or a string to lie about.
 * Commented-out code is not in the tree at all, which is the right answer.
 */
export function rendersClickableServerList(source: string): boolean {
  const tree = ts.createSourceFile(
    "f.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let found = false;
  const visit = (node: ts.Node, inServerMap: boolean) => {
    const mapping =
      inServerMap ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map" &&
        node.expression.expression.getText().toLowerCase().includes("server"));
    if (mapping) {
      if (ts.isJsxAttribute(node) && node.name.getText() === "onClick") {
        found = true;
      }
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        ["button", "Checkbox"].includes(node.tagName.getText())
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, (child) => visit(child, mapping));
  };
  visit(tree, false);
  return found;
}

/** Every app `.tsx` under `client/src`, posix-relative so ALLOWED reads the same everywhere. */
function appTsxFiles(): string[] {
  return readdirSync(CLIENT_SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".tsx") && !f.includes("__tests__"))
    .map((f) => f.split("\\").join("/"));
}

describe("one server picker", () => {
  const allTsx = appTsxFiles();
  const found = allTsx
    .filter((f) =>
      rendersClickableServerList(readFileSync(join(CLIENT_SRC, f), "utf8")),
    )
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
    // broken path would read as a clean repo.
    expect(allTsx.length).toBeGreaterThan(100);
    expect(found).toContain("components/ActiveServerSelector.tsx");
  });
});
