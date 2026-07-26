import { describe, expect, it } from "vitest";
import type { PluginSetupStatus } from "@/lib/plugins/plugin-api-types";
import {
  PLUGIN_UNSUPPORTED_EXPLANATION,
  describePluginHealth,
  describePluginReadiness,
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
  it("reports an unknown readiness code without claiming it is ready", () => {
    const described = describePluginReadiness(
      "some_future_state" as unknown as Parameters<
        typeof describePluginReadiness
      >[0],
    );
    expect(described.tone).toBe("attention");
    expect(described.label).toBe("some_future_state");
  });
});
