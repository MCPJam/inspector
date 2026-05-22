import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// `vi` is used by the "'Match host preset' chip" test below; the rest
// of the file uses the harness's stateful setDraft instead of a mock.
void vi;
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { AppsExtensionTab } from "../AppsExtensionTab";

/**
 * Component-level coverage for the SEP-1865 `app.*` matrix UI added in
 * the foundation series. The resolver, merge helper, and JSON round-
 * trip are already exhaustively covered in
 * `client-config-v2.test.ts` and `AppsExtensionTab.sandbox.test.ts`;
 * here we only assert that clicks on the structured matrix produce the
 * expected sparse-override edits on the draft, that the per-row
 * "Overridden" badge tracks the override map, and that the
 * "Match host preset" chip clears the matrix.
 */
/**
 * Render `AppsExtensionTab` with a managed draft that re-renders on
 * `onDraftChange`. The internal mutation must trigger a React re-render
 * so the matrix UI sees override edits applied before the next click —
 * a static draft would let stale state shadow the second user action.
 */
function renderMatrix(initial?: Partial<HostConfigInputV2>) {
  const draftRef: { current: HostConfigInputV2 } = {
    current: emptyHostConfigInputV2({ hostStyle: "claude", ...initial }),
  };
  function Harness({ initialDraft }: { initialDraft: HostConfigInputV2 }) {
    const [draft, setDraft] = useState<HostConfigInputV2>(initialDraft);
    draftRef.current = draft;
    return (
      <AppsExtensionTab
        draft={draft}
        onDraftChange={(updater) =>
          setDraft((prev) => {
            const next = updater(prev);
            draftRef.current = next;
            return next;
          })
        }
        attention={[]}
      />
    );
  }
  const utils = render(<Harness initialDraft={draftRef.current} />);
  return { draftRef, ...utils };
}

describe("AppsExtensionTab — McpAppsCapabilityMatrix", () => {
  it("renders the spec-bridge section with the SEP-1865 label", () => {
    renderMatrix();
    // Two-matrix architecture: window.openai and app.* are sibling
    // sections in the same tab. The label disambiguates them.
    expect(screen.getByText("app.*")).toBeInTheDocument();
    expect(screen.getByText(/SEP-1865/)).toBeInTheDocument();
  });

  it("starts at 'Matches host style preset' subline when no override is set", () => {
    renderMatrix();
    expect(screen.getByText(/Matches host style preset/)).toBeInTheDocument();
  });

  it("renders the availableDisplayModes cluster with Claude's preset (all three modes)", () => {
    renderMatrix();
    // Claude advertises the FULL surface: inline + fullscreen + pip.
    const cluster = screen
      .getByText("availableDisplayModes")
      .closest("div")!.parentElement!;
    for (const mode of ["inline", "fullscreen", "pip"] as const) {
      const button = within(cluster).getByRole("button", { name: mode });
      // Selected modes use the elevated background class.
      expect(button.className).toMatch(/bg-foreground/);
    }
  });

  it("toggling a boolean dimension produces a sparse override on the draft", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderMatrix();
    // toolInputPartial is on by default in Claude's preset; toggling
    // the switch should write `false` to mcpAppsOverrides.
    const row = screen.getByTestId("mcp-apps-dimension-toolInputPartial");
    const toggle = within(row).getByRole("switch");
    await user.click(toggle);
    expect(draftRef.current.mcpProfile?.apps?.mcpAppsOverrides).toEqual({
      toolInputPartial: false,
    });
  });

  it("toggling back to the preset value drops the override key (sparse on save)", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderMatrix();
    const row = screen.getByTestId("mcp-apps-dimension-toolInputPartial");
    const toggle = within(row).getByRole("switch");
    await user.click(toggle); // off (override)
    await user.click(toggle); // back on (matches preset → drop key)
    // Override block collapses to undefined (helper drops empty
    // objects on the draft).
    expect(draftRef.current.mcpProfile?.apps?.mcpAppsOverrides).toBeUndefined();
  });

  it("'Overridden' badge appears on rows where the user has diverged from the preset", () => {
    const draft = emptyHostConfigInputV2({ hostStyle: "claude" });
    draft.mcpProfile = {
      profileVersion: 1,
      apps: { mcpAppsOverrides: { logging: false } },
    };
    const onDraftChange = vi.fn();
    render(
      <AppsExtensionTab
        draft={draft}
        onDraftChange={onDraftChange}
        attention={[]}
      />,
    );
    const overriddenRow = screen.getByTestId("mcp-apps-dimension-logging");
    expect(within(overriddenRow).getByText("Overridden")).toBeInTheDocument();
    // Sibling row (no override) does NOT carry the badge.
    const cleanRow = screen.getByTestId(
      "mcp-apps-dimension-serverResources",
    );
    expect(within(cleanRow).queryByText("Overridden")).toBeNull();
  });

  it("'Match host preset' chip clears the entire matrix override", async () => {
    const user = userEvent.setup();
    const draft = emptyHostConfigInputV2({ hostStyle: "claude" });
    draft.mcpProfile = {
      profileVersion: 1,
      apps: {
        mcpAppsOverrides: { logging: false, serverResources: false },
      },
    };
    const draftRef = { current: draft };
    const onDraftChange = vi.fn(
      (updater: (prev: HostConfigInputV2) => HostConfigInputV2) => {
        draftRef.current = updater(draftRef.current);
      },
    );
    render(
      <AppsExtensionTab
        draft={draft}
        onDraftChange={onDraftChange}
        attention={[]}
      />,
    );
    const chip = screen.getByRole("button", { name: /Match host preset/ });
    expect(chip).toBeEnabled();
    await user.click(chip);
    expect(draftRef.current.mcpProfile?.apps?.mcpAppsOverrides).toBeUndefined();
  });

  it("'Match host preset' chip is disabled when no override is set", () => {
    renderMatrix();
    const chip = screen.getByRole("button", { name: /Match host preset/ });
    expect(chip).toBeDisabled();
  });

  it("the Advanced disclosure hides rare dimensions until expanded", async () => {
    const user = userEvent.setup();
    renderMatrix();
    // Sandbox sub-fields live in Advanced — hidden by default.
    expect(
      screen.queryByTestId("mcp-apps-dimension-sandboxPermissions"),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(
      screen.getByTestId("mcp-apps-dimension-sandboxPermissions"),
    ).toBeInTheDocument();
  });

  it("clicking a display mode in the cluster updates the allowlist on the draft", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderMatrix();
    // Claude's preset is [inline, fullscreen, pip]. Click "pip" to
    // remove it → override should be [inline, fullscreen].
    const cluster = screen
      .getByText("availableDisplayModes")
      .closest("div")!.parentElement!;
    await user.click(within(cluster).getByRole("button", { name: "pip" }));
    expect(
      draftRef.current.mcpProfile?.apps?.mcpAppsOverrides
        ?.availableDisplayModes,
    ).toEqual(["inline", "fullscreen"]);
  });

  it("force-enables inline when the user unchecks the last enabled mode", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderMatrix({ hostStyle: "copilot" });
    // Copilot preset is already ["fullscreen"]; unchecking it should
    // coerce to ["inline"] (matrix invariant — never empty).
    const cluster = screen
      .getByText("availableDisplayModes")
      .closest("div")!.parentElement!;
    await user.click(
      within(cluster).getByRole("button", { name: "fullscreen" }),
    );
    expect(
      draftRef.current.mcpProfile?.apps?.mcpAppsOverrides
        ?.availableDisplayModes,
    ).toEqual(["inline"]);
  });
});
