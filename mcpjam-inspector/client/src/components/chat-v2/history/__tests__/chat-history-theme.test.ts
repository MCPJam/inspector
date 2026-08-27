import { describe, expect, it } from "vitest";
import { CHAT_HISTORY_STRONG_BG_CLASS } from "../chat-history-theme";

/**
 * The rail is a PANEL surface, so its active row has to be painted from the
 * `accent` family like the rest of the panel.
 *
 * Pinned because the failure is silent and easy to reintroduce: the Production
 * Redesign (BB-127) swapped what `--sidebar` and `--sidebar-accent` mean, which
 * left a `bg-sidebar-accent` row here PALER than this same rail's own
 * `hover:bg-accent/50` — the selected chat looked unselected, and nothing
 * type-errored.
 */
describe("chat history active-row tokens", () => {
  it("paints every host family from the accent family, never the sidebar's", () => {
    for (const [family, classes] of Object.entries(
      CHAT_HISTORY_STRONG_BG_CLASS
    )) {
      expect(classes, family).toContain("bg-accent");
      expect(classes, family).not.toContain("sidebar");
    }
  });
});
