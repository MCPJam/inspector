import { describe, expect, it } from "vitest";
import { HARNESS_MCP_DELIVERY } from "@/shared/harness-mcp-delivery";
import type { HostConfigHarnessV2 } from "@/lib/client-config-v2";
import {
  HARNESS_DISPLAY_NAME,
  harnessControlState,
  type HarnessGatedControl,
} from "@/lib/harness-capabilities";

const HARNESSES = Object.keys(
  HARNESS_MCP_DELIVERY,
) as HostConfigHarnessV2[];

describe("harnessControlState — tool visibility is DERIVED from delivery mode", () => {
  // The regression this file exists for: `respectToolVisibility` was a
  // hardcoded `{enforced:false}` per harness. When Codex's host-executed
  // projection started threading `includeAppOnly` from the knob (COMP-39), the
  // literal stayed stale — the editor disabled a switch that worked and blamed
  // it on a limitation that no longer existed. This asserts the COUPLING, not
  // the current answer, so it fails again the moment the two diverge.
  it("tracks the shared delivery declaration for EVERY harness", () => {
    for (const harness of HARNESSES) {
      const state = harnessControlState(harness, "respectToolVisibility");
      expect(
        state.enforced,
        `respectToolVisibility for ${harness} (delivery=${HARNESS_MCP_DELIVERY[harness]})`,
      ).toBe(HARNESS_MCP_DELIVERY[harness] === "host-executed");
    }
    // Guard the guard: if this ever stops covering both arms, the loop above
    // could pass vacuously while proving nothing about the derivation.
    const modes = new Set(HARNESSES.map((h) => HARNESS_MCP_DELIVERY[h]));
    expect(modes).toEqual(new Set(["native", "host-executed"]));
  });

  it("Codex enforces it — MCPJam builds those tools itself", () => {
    // Host-executed delivery runs the SAME `getToolsForAiSdk` projection the
    // emulated engine runs, under the host's own options, so the knob bites.
    expect(harnessControlState("codex", "respectToolVisibility")).toEqual({
      enforced: true,
    });
  });

  it("Claude Code does not — and says why in terms of the mechanism", () => {
    const state = harnessControlState("claude-code", "respectToolVisibility");
    expect(state.enforced).toBe(false);
    // The note must describe the DELIVERY mechanism, not a per-harness "yet",
    // so it stays true for any future natively-delivering harness.
    expect(state.enforced === false && state.note).toMatch(
      /connects to MCP servers itself/i,
    );
  });
});

describe("harnessControlState — loop-owned controls", () => {
  // Loop-owned does NOT mean permanently unenforced — it means the harness's
  // own loop decides, so the answer is per harness and can change when the
  // runtime gains the capability. `requireToolApproval` is exactly that case:
  // Claude Code pauses on all three tool surfaces now, so it is enforced there
  // while Codex (which cannot pause at all) still is not.
  const ALWAYS_UNENFORCED: HarnessGatedControl[] = [
    "temperature",
    "progressiveToolDiscovery",
  ];

  it("stay unenforced on both harnesses (the harness owns its own loop)", () => {
    for (const harness of HARNESSES) {
      for (const control of ALWAYS_UNENFORCED) {
        const state = harnessControlState(harness, control);
        expect(state.enforced, `${harness}.${control}`).toBe(false);
        expect(state.enforced === false && state.note.length).toBeGreaterThan(0);
      }
    }
  });

  it("enforces requireToolApproval on Claude Code and not on Codex", () => {
    // The note is the thing users read when a control is grayed out, so an
    // unenforced entry must still explain itself.
    expect(harnessControlState("claude-code", "requireToolApproval")).toEqual({
      enforced: true,
    });
    const codex = harnessControlState("codex", "requireToolApproval");
    expect(codex.enforced).toBe(false);
    expect(codex.enforced === false && codex.note.length).toBeGreaterThan(0);
  });
});

describe("harnessControlState — emulated engine", () => {
  it("enforces every control when there is no harness", () => {
    const controls: HarnessGatedControl[] = [
      "modelId",
      "temperature",
      "requireToolApproval",
      "respectToolVisibility",
      "progressiveToolDiscovery",
    ];
    for (const control of controls) {
      expect(harnessControlState(undefined, control)).toEqual({
        enforced: true,
      });
    }
  });

  it("fails OPEN for an unknown harness id rather than graying a control out", () => {
    const unknown = "pi" as HostConfigHarnessV2;
    expect(harnessControlState(unknown, "temperature").enforced).toBe(true);
    // The model is the most consequential control to gray out by accident — a
    // future harness id must not lose its model selector on a guess.
    expect(harnessControlState(unknown, "modelId").enforced).toBe(true);
    // The derived arm needs its own fail-open: an id with no delivery
    // declaration must not silently read as `native` and disable the switch.
    expect(harnessControlState(unknown, "respectToolVisibility").enforced).toBe(
      true,
    );
  });
});

describe("harnessControlState — who chooses the MODEL", () => {
  /**
   * The distinction this control exists for. Claude Code and Codex run on model
   * credentials MCPJam brokers, so the host's selection IS what launches. The
   * Cursor CLI authenticates with the customer's own Cursor account and that
   * account picks the model, so a selection persists onto the host, shows in
   * the editor, and reaches nothing — a saved setting that lies about what ran.
   */
  it("is enforced exactly for the harnesses whose models MCPJam brokers", () => {
    expect(harnessControlState("claude-code", "modelId")).toEqual({
      enforced: true,
    });
    expect(harnessControlState("codex", "modelId")).toEqual({ enforced: true });

    const cursor = harnessControlState("cursor", "modelId");
    expect(cursor.enforced).toBe(false);
    // The note is what a user reads beside the disabled selector, so it has to
    // name the account that actually decides — not read as an MCPJam limit.
    expect(cursor.enforced === false && cursor.note).toMatch(
      /Cursor account.*chooses the model/i,
    );
  });

  it("leaves the emulated host's selector alone", () => {
    // The emulated `cursor` host style (the IDE chat panel) carries no harness
    // and picks its model normally. Only the CLI runtime is gated.
    expect(harnessControlState(undefined, "modelId")).toEqual({
      enforced: true,
    });
  });
});

describe("harnessControlState — the Cursor CLI runtime", () => {
  it("enforces tool approval on its native surface", () => {
    // Not a formality: the ACP bridge routes every native call through
    // `session/request_permission`, so unlike Codex the turn genuinely pauses.
    // Reading this as unenforced would tell users approval does nothing here.
    expect(harnessControlState("cursor", "requireToolApproval")).toEqual({
      enforced: true,
    });
  });

  it("cannot filter tool visibility, because it connects to MCP servers itself", () => {
    const state = harnessControlState("cursor", "respectToolVisibility");
    expect(state.enforced).toBe(false);
    expect(state.enforced === false && state.note).toMatch(
      /connects to MCP servers itself/i,
    );
  });
});

describe("HARNESS_DISPLAY_NAME", () => {
  it("names the CLI runtime, never the bare product", () => {
    // "Cursor" alone is the emulated IDE chat-panel host style, which is a
    // different thing a user can also attach. A label that did not distinguish
    // them would make the two indistinguishable in every picker.
    expect(HARNESS_DISPLAY_NAME.cursor).toBe("Cursor CLI");
  });

  it("names every harness that has a delivery declaration", () => {
    // The two maps are keyed by the same union; a harness added to one and not
    // the other renders as a blank or an id somewhere in the host UI.
    for (const harness of HARNESSES) {
      expect(HARNESS_DISPLAY_NAME[harness], harness).toBeTruthy();
    }
  });
});
