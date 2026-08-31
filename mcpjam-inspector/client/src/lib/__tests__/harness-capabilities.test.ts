import { describe, expect, it } from "vitest";
import { HARNESS_MCP_DELIVERY } from "@/shared/harness-mcp-delivery";
import type { HostConfigHarnessV2 } from "@/lib/client-config-v2";
import {
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
  const LOOP_CONTROLS: HarnessGatedControl[] = [
    "temperature",
    "requireToolApproval",
    "progressiveToolDiscovery",
  ];

  it("stay unenforced on both harnesses (the harness owns its own loop)", () => {
    for (const harness of HARNESSES) {
      for (const control of LOOP_CONTROLS) {
        const state = harnessControlState(harness, control);
        expect(state.enforced, `${harness}.${control}`).toBe(false);
        expect(state.enforced === false && state.note.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("harnessControlState — emulated engine", () => {
  it("enforces every control when there is no harness", () => {
    const controls: HarnessGatedControl[] = [
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
    // The derived arm needs its own fail-open: an id with no delivery
    // declaration must not silently read as `native` and disable the switch.
    expect(harnessControlState(unknown, "respectToolVisibility").enforced).toBe(
      true,
    );
  });
});
