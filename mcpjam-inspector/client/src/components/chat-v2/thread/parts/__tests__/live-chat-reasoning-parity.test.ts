import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIVE_CHAT_REASONING_DISPLAY_MODE } from "../reasoning-part";

/**
 * Guard for the BB-111 follow-up bug.
 *
 * `Thread` defaults `reasoningDisplayMode` to "inline", and there is more than
 * one live-chat path that renders it. Setting the collapsed mode on only some
 * of them is exactly what shipped first: with two models selected reasoning
 * appeared as a tidy collapsed block, but with a single client selected it
 * rendered as raw inline text with no header at all.
 *
 * These are source-level assertions on purpose. Rendering `PlaygroundMain`
 * needs most of the app's providers, and the failure mode here is not "the
 * component misbehaves" — it is "a live surface forgot to pass the prop".
 * Reading the call site catches that directly, and catches it for a NEW live
 * surface too.
 */
const LIVE_CHAT_THREAD_CALL_SITES = [
  // Single-host Playground thread — the path that regressed.
  "../../../../ui-playground/PlaygroundMain.tsx",
  // Multi-model / multi-host compare cards.
  "../../../../ui-playground/multi-model-playground-card.tsx",
  // MCPJam agent thread.
  "../../../../mcpjam-agent/McpjamAgentThread.tsx",
] as const;

describe("live chat reasoning display parity", () => {
  it("collapses reasoning on live chat surfaces", () => {
    // Pinned so flipping the shared default is a deliberate, visible edit
    // rather than something that silently changes every live surface.
    expect(LIVE_CHAT_REASONING_DISPLAY_MODE).toBe("collapsed");
  });

  it.each(LIVE_CHAT_THREAD_CALL_SITES)(
    "%s drives reasoning display from the shared constant",
    (relativePath) => {
      const source = readFileSync(
        new URL(relativePath, import.meta.url),
        "utf8",
      );

      expect(source).toContain("LIVE_CHAT_REASONING_DISPLAY_MODE");

      // Referencing the constant is not enough on its own. The compare card
      // reaches `Thread` in two hops — the constant sits on its prop DEFAULT
      // and the value is forwarded separately — so deleting the forwarding
      // line (the exact "forgot to pass the prop" regression this guards)
      // would leave the constant in the file and pass a name-only check while
      // the surface silently fell back to `Thread`'s "inline". Require an
      // actual prop pass too.
      expect(source).toMatch(/reasoningDisplayMode=\{/);

      // A hardcoded mode next to the import is how these drifted apart before.
      // Ban EVERY string literal in a `reasoningDisplayMode` position, not just
      // the old "inline": the drift this guards against is "a live surface got
      // a different mode", and a hardcoded "collapsible" would otherwise pass
      // every assertion above as long as the import line survived.
      //
      // All three quote styles, braced or not, so the ban does not hinge on the
      // formatter's quote preference: a `'collapsible'` or a template literal
      // is the same drift as a `"collapsible"`, and a guard that only knows
      // about double quotes silently stops guarding the day one of the others
      // shows up. Covers the JSX forms (`="..."`, `={"..."}`) and a prop
      // default (`= "..."`).
      expect(source).not.toMatch(
        /reasoningDisplayMode\s*=\s*(?:\{\s*)?(?:"[^"]*"|'[^']*'|`[^`]*`)/,
      );
    },
  );
});
