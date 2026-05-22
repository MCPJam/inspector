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
  it("renders the MCP Apps section header", () => {
    renderMatrix();
    // Two-matrix architecture: window.openai and MCP Apps are sibling
    // sections in the same tab.
    expect(screen.getByText("MCP Apps")).toBeInTheDocument();
  });

  it("does not show Preset hints on matrix rows", () => {
    renderMatrix();
    expect(screen.queryByText(/^Preset:/)).toBeNull();
  });

  it("shows an enabled-capability summary when no override is set", () => {
    renderMatrix();
    expect(screen.getByText("15 of 15 enabled")).toBeInTheDocument();
  });

  it("renders the availableDisplayModes cluster with Claude's preset (all three modes)", () => {
    renderMatrix();
    // Claude advertises the FULL surface: inline + fullscreen + pip.
    const cluster = screen.getByTestId("mcp-apps-dimension-availableDisplayModes");
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

  it("reverting the last matrix override returns the draft to its original profile state (no dirty empty envelope)", async () => {
    // Regression: setMcpAppsOverridesOnDraft used to leave
    // `{ profileVersion: 1, apps: {} }` behind after the last
    // override was cleared. `hostConfigInputsEqual` treats that as
    // distinct from `undefined`, so the draft stayed dirty while the
    // matrix said "Matches host style preset". Toggling a row and
    // toggling it back must round-trip the draft exactly.
    const user = userEvent.setup();
    const { draftRef } = renderMatrix();
    expect(draftRef.current.mcpProfile).toBeUndefined();
    const row = screen.getByTestId("mcp-apps-dimension-toolInputPartial");
    const toggle = within(row).getByRole("switch");
    await user.click(toggle); // off (override)
    await user.click(toggle); // back on → matrix clean
    // Profile must collapse back to undefined — no synthesized
    // `{ profileVersion: 1, apps: {} }` left behind.
    expect(draftRef.current.mcpProfile).toBeUndefined();
  });

  it("preserves sibling apps fields when clearing the last matrix override", async () => {
    // Counter-test: the empty-collapse must NOT drop unrelated
    // `apps.*` siblings. If the user has a `compatRuntime` block
    // alongside, removing all matrix overrides leaves apps.{compat,
    // sandbox, uiInitialize} intact and clears only mcpAppsOverrides.
    const user = userEvent.setup();
    const { draftRef } = renderMatrix({
      mcpProfile: {
        profileVersion: 1,
        apps: {
          compatRuntime: { openaiApps: false },
          mcpAppsOverrides: { toolInputPartial: false },
        },
      },
    });
    const row = screen.getByTestId("mcp-apps-dimension-toolInputPartial");
    const toggle = within(row).getByRole("switch");
    await user.click(toggle); // back to preset → drop the override key
    expect(draftRef.current.mcpProfile?.apps?.mcpAppsOverrides).toBeUndefined();
    expect(draftRef.current.mcpProfile?.apps?.compatRuntime?.openaiApps).toBe(
      false,
    );
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

  it("Reset button clears the entire matrix override", async () => {
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
    const reset = screen.getByRole("button", { name: "Reset" });
    await user.click(reset);
    expect(draftRef.current.mcpProfile?.apps?.mcpAppsOverrides).toBeUndefined();
  });

  it("hides the Reset button when no override is set", () => {
    renderMatrix();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("renders all matrix dimensions in one flat list", () => {
    renderMatrix();
    expect(
      screen.getByTestId("mcp-apps-dimension-sandboxPermissions"),
    ).toBeInTheDocument();
    expect(screen.queryByText("ADVANCED")).toBeNull();
    expect(screen.queryByText(/Notifications & capabilities/i)).toBeNull();
  });

  it("clicking a display mode in the cluster updates the allowlist on the draft", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderMatrix();
    // Claude's preset is [inline, fullscreen, pip]. Click "pip" to
    // remove it → override should be [inline, fullscreen].
    const cluster = screen.getByTestId("mcp-apps-dimension-availableDisplayModes");
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
    const cluster = screen.getByTestId("mcp-apps-dimension-availableDisplayModes");
    await user.click(
      within(cluster).getByRole("button", { name: "fullscreen" }),
    );
    expect(
      draftRef.current.mcpProfile?.apps?.mcpAppsOverrides
        ?.availableDisplayModes,
    ).toEqual(["inline"]);
  });
});

describe("AppsExtensionTab — McpAppsCapabilityMatrix legacy-override migration", () => {
  it("displays a legacy hostCapabilitiesOverride as a virtually-migrated matrix (Overridden badges reflect what the resolver advertises)", () => {
    // Regression (Codex Bot on #2236): if the draft has legacy
    // `hostCapabilitiesOverride` and no `mcpAppsOverrides`, the matrix
    // UI must reflect the legacy values — otherwise the first toggle
    // would write a sparse override relative to the bare preset, and
    // the resolver would silently flip every other legacy-overridden
    // dimension back to the preset.
    const draft = emptyHostConfigInputV2({ hostStyle: "claude" });
    // Legacy override stripped serverResources + logging (advertise
    // neither). Matrix UI must reflect both as Overridden.
    draft.hostCapabilitiesOverride = {
      openLinks: {},
      serverTools: {},
      updateModelContext: { text: {} },
      message: { text: {} },
    };
    render(
      <AppsExtensionTab
        draft={draft}
        onDraftChange={() => {}}
        attention={[]}
      />,
    );
    // serverResources and logging are missing from the legacy
    // override → migrated matrix sets them to false → "Overridden"
    // badge present because Claude's preset has them true.
    const serverResources = screen.getByTestId(
      "mcp-apps-dimension-serverResources",
    );
    expect(within(serverResources).getByText("Overridden")).toBeInTheDocument();
    const logging = screen.getByTestId("mcp-apps-dimension-logging");
    expect(within(logging).getByText("Overridden")).toBeInTheDocument();
    // Subline annotated as legacy so the user knows where the values
    // came from.
    expect(screen.getByText(/legacy/)).toBeInTheDocument();
  });

  it("migrates legacy → matrix on the first row toggle and clears the legacy field", async () => {
    // The key write-side fix: when the user toggles a single row on a
    // legacy-only draft, the migration runs first so the user's edit
    // doesn't silently drop the other legacy-overridden dimensions.
    // Post-edit the legacy field is cleared (matrix becomes the new
    // source of truth) and `mcpAppsOverrides` reflects legacy +
    // user's edit, not just user's edit.
    const user = userEvent.setup();
    const { draftRef } = renderMatrix({
      hostStyle: "claude",
      hostCapabilitiesOverride: {
        openLinks: {},
        serverTools: {},
        // serverResources, logging, updateModelContext, message all
        // stripped — legacy says "advertise none of those four".
      },
    });
    // Sanity: legacy is set, matrix is absent.
    expect(draftRef.current.hostCapabilitiesOverride).toBeDefined();
    expect(
      draftRef.current.mcpProfile?.apps?.mcpAppsOverrides,
    ).toBeUndefined();
    // User toggles a single sibling row (toolInputPartial).
    const row = screen.getByTestId("mcp-apps-dimension-toolInputPartial");
    await user.click(within(row).getByRole("switch"));
    // Legacy cleared.
    expect(draftRef.current.hostCapabilitiesOverride).toBeUndefined();
    // Matrix now carries the migrated legacy PLUS the new edit. The
    // other legacy-overridden dimensions are NOT silently lost.
    const matrix = draftRef.current.mcpProfile?.apps?.mcpAppsOverrides;
    expect(matrix).toMatchObject({
      serverResources: false,
      logging: false,
      updateModelContext: false,
      message: false,
      toolInputPartial: false, // the user's edit
    });
  });

  it("Reset clears both the matrix override AND the legacy hostCapabilitiesOverride", async () => {
    // The chip's contract is "revert to preset". If we only cleared
    // the matrix, the legacy path would silently keep the override
    // alive — the matrix would say "Matches host style preset" while
    // the resolver advertised the legacy shape.
    const user = userEvent.setup();
    const { draftRef } = renderMatrix({
      hostStyle: "claude",
      hostCapabilitiesOverride: {
        openLinks: {},
        serverTools: {},
      },
    });
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(draftRef.current.hostCapabilitiesOverride).toBeUndefined();
    expect(
      draftRef.current.mcpProfile?.apps?.mcpAppsOverrides,
    ).toBeUndefined();
  });
});
