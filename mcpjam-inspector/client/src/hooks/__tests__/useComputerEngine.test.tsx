import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * The one resolution rule, pinned as a matrix. The load-bearing rows: consent
 * GATES local at every step (a stored "local" pref without a verified
 * capability falls through to cloud — the badge can never say "This machine"
 * while commands go elsewhere), and hosted never reads storage at all.
 */
const state = vi.hoisted(() => ({
  hosted: false,
  config: undefined as unknown,
  consentGranted: false,
}));

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("@/hooks/useProjectComputer", () => ({
  useComputersDataPlaneConfig: () => state.config,
}));
vi.mock("@/hooks/useLocalComputerConsent", () => ({
  useLocalComputerConsent: () => ({
    status: state.consentGranted ? "granted" : "absent",
    granted: state.consentGranted,
    token: state.consentGranted ? "tok" : null,
    grant: vi.fn(),
    revoke: vi.fn(),
  }),
}));

import { useComputerEngine } from "../useComputerEngine";
import { saveComputerEngine } from "@/lib/computer-engine-storage";

function config(overrides: {
  localAvailable?: boolean;
  cloudAvailable?: boolean;
  defaultEngine?: "local" | "cloud" | null;
  terminalAvailable?: boolean;
}) {
  return {
    localConfigured: false,
    remoteDataPlaneUrl: null,
    engines: {
      local: {
        available: overrides.localAvailable ?? true,
        terminalAvailable: overrides.terminalAvailable ?? false,
        workspaceDisplayRoot:
          (overrides.localAvailable ?? true) ? "~/.mcpjam/computer" : null,
      },
      cloud: { available: overrides.cloudAvailable ?? true },
    },
    defaultEngine: overrides.defaultEngine ?? "local",
  };
}

describe("useComputerEngine", () => {
  beforeEach(() => {
    localStorage.clear();
    state.hosted = false;
    state.config = config({});
    state.consentGranted = false;
  });

  it("hosted: always cloud, toggle hidden, storage untouched", () => {
    state.hosted = true;
    saveComputerEngine("p1", "local");
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.engine).toBe("cloud");
    expect(result.current.toggleVisible).toBe(false);
    expect(result.current.localAvailable).toBe(false);
  });

  it("consent gates local: server default 'local' without consent resolves cloud", () => {
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.engine).toBe("cloud");
  });

  it("consent granted: server default 'local' resolves local — no stored pref needed", () => {
    state.consentGranted = true;
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.engine).toBe("local");
  });

  it("a stored 'local' pref without consent falls through to cloud", () => {
    saveComputerEngine("p1", "local");
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.engine).toBe("cloud");
  });

  it("a stored 'cloud' pref beats the server's local default even with consent", () => {
    state.consentGranted = true;
    saveComputerEngine("p1", "cloud");
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.engine).toBe("cloud");
  });

  it("setEngine persists and re-resolves live", () => {
    state.consentGranted = true;
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.engine).toBe("local");
    act(() => {
      result.current.setEngine("cloud");
    });
    expect(result.current.engine).toBe("cloud");
  });

  it("a project switch reads the NEW project's preference immediately (no stale render)", () => {
    state.consentGranted = true;
    // p1 pinned to cloud; p2 has no stored pref → the server 'local' default.
    saveComputerEngine("p1", "cloud");
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string | null }) => useComputerEngine(pid),
      { initialProps: { pid: "p1" as string | null } },
    );
    expect(result.current.engine).toBe("cloud");
    rerender({ pid: "p2" });
    // Must NOT briefly report p1's "cloud" for p2 — synchronous re-key.
    expect(result.current.engine).toBe("local");
    rerender({ pid: null });
    expect(result.current.engine).toBe("local"); // no project pref → default
  });

  it("local-only machine with consent: local wins even with defaultEngine null", () => {
    state.consentGranted = true;
    state.config = config({
      cloudAvailable: false,
      defaultEngine: null,
    });
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.engine).toBe("local");
    expect(result.current.toggleVisible).toBe(false);
  });

  it("nothing available: cloud with cloudAvailable=false (the honest empty state)", () => {
    state.config = config({
      localAvailable: false,
      cloudAvailable: false,
      defaultEngine: null,
    });
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.engine).toBe("cloud");
    expect(result.current.cloudAvailable).toBe(false);
    expect(result.current.toggleVisible).toBe(false);
  });

  it("loading config: resolved=false and the safe cloud default", () => {
    state.config = undefined;
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.resolved).toBe(false);
    expect(result.current.engine).toBe("cloud");
  });

  it("toggle shows only when BOTH engines exist (consent not required to see it)", () => {
    state.config = config({});
    const { result } = renderHook(() => useComputerEngine("p1"));
    expect(result.current.toggleVisible).toBe(true);
  });
});
