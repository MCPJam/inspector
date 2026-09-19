import ts from "typescript";
import { describe, expect, it } from "vitest";
import { appTsxFiles, parseTsx, readAppFile } from "./support/client-tsx";

/**
 * One picker, guarded by the compiler.
 *
 * BB-142 started with three components that all let a user choose a server and
 * no rule about which a new surface should reach for. Deleting them fixes
 * today; it does not stop a fourth next month. So this is an INVENTORY LOCK,
 * not a proof: it finds every file that renders a clickable list of servers
 * and asserts the set is exactly the one below. A new one fails with a pointer
 * to `ServerPicker`; a listed one that stops matching fails too, so the list
 * cannot become a record of what was once true.
 *
 * Read through `typescript` rather than by scanning text — the hand-written
 * version balanced parentheses over raw source, and a `)` in a comment, a
 * nested template literal and a `//` in JSX each made it MISS a picker.
 *
 * SCOPE: `client/src` only, and it matches on SHAPE — a `.map(` whose receiver
 * mentions "server", holding a click or checkbox. A list built some other way
 * passes unexamined, and it cannot tell a picker from a list that merely
 * happens to be clickable. That judgement is why each entry carries a reason.
 */
const ALLOWED: Record<string, string> = {
  "components/hosts/server-selection-list.tsx":
    "The shared multi-select leaf: checkbox rows, no data, no popover. Its " +
    "last production importer was ServerGroupPicker, deleted here, and the " +
    "only importer left — hosts/attachment-editor.tsx — has no importers of " +
    "its own, so nothing renders this today. Kept rather than deleted because " +
    "that editor is pre-existing dead code this change did not bring in; " +
    "removing both is its own commit. Listed so the guard states what is " +
    "true now, not what was true when it was written.",

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

  "components/mcpjam-agent/DescribeContextStatus.tsx":
    "Recovery actions, not a choice. Each row is one server whose tools failed " +
    "to load, with a Reconnect/Retry button that re-runs the handshake and " +
    "leaves the list as it was. Nothing is selected and no serverAttachmentId " +
    "is written.",

  "components/plugins/PluginGroupCard.tsx":
    "A plugin version's declared components, listed with their setup state. " +
    "The rows open a requirement editor, they do not attach a server.",
};

/** Walked as a tree: a `.map(` node has an exact extent, so nothing lies. */
export function rendersClickableServerList(source: string): boolean {
  const tree = parseTsx(source);
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

describe("one server picker", () => {
  const allTsx = appTsxFiles();
  const found = allTsx
    .filter((f) => rendersClickableServerList(readAppFile(f)))
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
    // An entry has to leave with the surface it describes.
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
    // Without this a broken path reads as a clean repo.
    expect(allTsx.length).toBeGreaterThan(100);
    expect(found).toContain("components/ActiveServerSelector.tsx");
  });
});
