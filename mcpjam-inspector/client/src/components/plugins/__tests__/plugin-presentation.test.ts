import { describe, expect, it } from "vitest";
import type { PluginSetupStatus } from "@/lib/plugins/plugin-api-types";
import {
  PLUGIN_UNSUPPORTED_EXPLANATION,
  describePluginHealth,
  describePluginReadiness,
  describeSkippedComponentKind,
  rollUpPluginHealth,
} from "../plugin-presentation";

function status(
  readinesses: Array<PluginSetupStatus["components"][number]["readiness"]>,
  overrides: Partial<PluginSetupStatus> = {},
): PluginSetupStatus {
  return {
    pluginVersionId: "v_1",
    status: "ready",
    components: readinesses.map((readiness, index) => ({
      componentKey: `server:${index}`,
      placement: "remote",
      authenticationPolicy: "on_use",
      readiness,
    })),
    ...overrides,
  };
}

const installed = { enabled: true, activeVersionId: "v_1" };

describe("rollUpPluginHealth", () => {
  it("is ready only when every component is", () => {
    expect(rollUpPluginHealth(installed, status(["ready", "ready"]))).toEqual({
      kind: "ready",
      componentCount: 2,
    });
  });

  it("never reports ready while one component needs auth", () => {
    expect(
      rollUpPluginHealth(installed, status(["ready", "needs_auth"])),
    ).toEqual({ kind: "needs_attention", readiness: "needs_auth" });
  });

  it("prefers needs_auth over a placement constraint", () => {
    expect(
      rollUpPluginHealth(
        installed,
        status(["local_runtime_required", "needs_auth"]),
      ),
    ).toEqual({ kind: "needs_attention", readiness: "needs_auth" });
  });

  it("never reports ready while one component needs configuration", () => {
    expect(
      rollUpPluginHealth(installed, status(["ready", "needs_setup"])),
    ).toEqual({ kind: "needs_attention", readiness: "needs_setup" });
    expect(
      rollUpPluginHealth(
        installed,
        status(["local_runtime_required", "needs_setup"]),
      ),
    ).toEqual({ kind: "needs_attention", readiness: "needs_setup" });
  });

  it("treats a component-less ready version as ready", () => {
    expect(rollUpPluginHealth(installed, status([]))).toEqual({
      kind: "ready",
      componentCount: 0,
    });
  });

  it("does not claim readiness before setup status loads", () => {
    expect(rollUpPluginHealth(installed, undefined)).toEqual({
      kind: "unknown",
    });
  });

  it("does not claim readiness for a staging (not finalized) version", () => {
    expect(
      rollUpPluginHealth(installed, status(["ready"], { status: "staging" })),
    ).toEqual({ kind: "unknown" });
  });

  it("reports disabled and not-activated before anything else", () => {
    expect(
      rollUpPluginHealth(
        { enabled: false, activeVersionId: "v_1" },
        status(["ready"]),
      ),
    ).toEqual({ kind: "disabled" });
    expect(
      rollUpPluginHealth(
        { enabled: true, activeVersionId: undefined },
        status(["ready"]),
      ),
    ).toEqual({ kind: "not_activated" });
  });
});

describe("describePluginHealth", () => {
  it("carries a detail for every rollup so badge-only surfaces can explain it", () => {
    const healths = [
      { kind: "disabled" },
      { kind: "not_activated" },
      { kind: "unknown" },
      { kind: "ready", componentCount: 1 },
      { kind: "needs_attention", readiness: "needs_auth" },
    ] as const;
    for (const health of healths) {
      expect(describePluginHealth(health).detail.length).toBeGreaterThan(0);
    }
    // An unrecognized backend state keeps its raw code in the detail — the
    // only place a card rendering just the badge can surface it.
    expect(
      describePluginHealth({
        kind: "needs_attention",
        readiness: "some_future_state",
      }).detail,
    ).toContain("some_future_state");
  });

  it("only ever says Ready for the ready rollup", () => {
    const labels = (
      [
        { kind: "disabled" },
        { kind: "not_activated" },
        { kind: "unknown" },
        { kind: "needs_attention", readiness: "needs_auth" },
      ] as const
    ).map((health) => describePluginHealth(health).label);
    expect(labels).not.toContain("Ready");
    expect(
      describePluginHealth({ kind: "ready", componentCount: 1 }).label,
    ).toBe("Ready");
  });
});

describe("unsupported component wording", () => {
  it("never describes an unsupported component as executable", () => {
    expect(PLUGIN_UNSUPPORTED_EXPLANATION).toMatch(/does not run/i);
    expect(PLUGIN_UNSUPPORTED_EXPLANATION).not.toMatch(
      /\bruns\b|\bexecut(e|es|able)\b|\bsupported\b/i,
    );
  });
});

describe("describePluginReadiness", () => {
  it("describes needs_setup as needing configuration", () => {
    const described = describePluginReadiness("needs_setup");
    expect(described.label).toBe("Needs configuration");
    expect(described.tone).toBe("attention");
  });

  it("reports an unknown readiness code as neutral setup-required, never ready", () => {
    const described = describePluginReadiness("some_future_state");
    expect(described.tone).toBe("attention");
    expect(described.label).toBe("Setup required");
    // The raw code stays diagnosable in the detail line.
    expect(described.detail).toContain("some_future_state");
  });
});

describe("describeSkippedComponentKind", () => {
  it("labels the parser's failure-isolation kinds and echoes unknown ones", () => {
    expect(describeSkippedComponentKind("server")).toBe("MCP server");
    expect(describeSkippedComponentKind("skill")).toBe("Skill");
    expect(describeSkippedComponentKind("mcp-config")).toBe(
      "MCP configuration",
    );
    expect(describeSkippedComponentKind("future-kind")).toBe("future-kind");
  });
});
