import { describe, expect, it } from "vitest";
import { visibleHostFocusTabs } from "../host-focus-tab-defs";

const ids = (opts: Parameters<typeof visibleHostFocusTabs>[0]) =>
  visibleHostFocusTabs(opts).map((t) => t.id);

describe("visibleHostFocusTabs", () => {
  it("shows Tools only when the deployment exposes built-in tools", () => {
    const base = { computersEnabled: false, computerAttached: false };
    expect(ids({ ...base, hasBuiltInTools: false })).not.toContain("tools");
    expect(ids({ ...base, hasBuiltInTools: true })).toContain("tools");
  });

  it("gates Computer behind the flag", () => {
    const base = { hasBuiltInTools: true, computerAttached: false };
    expect(ids({ ...base, computersEnabled: false })).not.toContain("computer");
    expect(ids({ ...base, computersEnabled: true })).toContain("computer");
  });

  it("still shows Computer when one is attached even with the flag off (so it stays detachable)", () => {
    expect(
      ids({
        hasBuiltInTools: true,
        computersEnabled: false,
        computerAttached: true,
      }),
    ).toContain("computer");
  });

  it("always keeps the static tabs (Agent, MCP Protocol, Apps)", () => {
    const result = ids({
      hasBuiltInTools: false,
      computersEnabled: false,
      computerAttached: false,
    });
    expect(result).toEqual(["behavior", "protocol", "apps"]);
  });

  it("orders the optional tabs at the right end when present", () => {
    const result = ids({
      hasBuiltInTools: true,
      computersEnabled: true,
      computerAttached: false,
    });
    expect(result).toEqual([
      "behavior",
      "protocol",
      "apps",
      "tools",
      "computer",
    ]);
  });
});
