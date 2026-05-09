import { beforeEach, describe, expect, it } from "vitest";
import { loadAppState, saveAppState } from "../storage";

describe("storage (no-op post-unification)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loadAppState returns initial state without reading legacy storage", () => {
    // Prefill the legacy keys to verify they're ignored — Convex is the
    // single source of truth post-unification; the migration shim
    // (`local-state-migration.ts`) is the only thing that reads these keys.
    localStorage.setItem("mcp-inspector-state", JSON.stringify({ servers: {} }));
    localStorage.setItem(
      "mcp-inspector-projects",
      JSON.stringify({ projects: { "legacy-1": { name: "Legacy" } } }),
    );

    const state = loadAppState();

    // Initial state has the synthetic local default project (kept until the
    // Convex `useProjectServers` query echoes back). The crucial assertion
    // is that NO legacy project ("legacy-1") makes it into the result.
    expect(Object.keys(state.projects)).not.toContain("legacy-1");
    expect(state.servers).toEqual({});
    expect(state.selectedServer).toBe("none");
  });

  it("loadAppState clears stale persisted OAuth traces from localStorage", () => {
    localStorage.setItem(
      "mcp-oauth-trace-asana",
      JSON.stringify({ version: 1, currentStep: "token_request" }),
    );

    loadAppState();

    expect(localStorage.getItem("mcp-oauth-trace-asana")).toBeNull();
  });

  it("saveAppState is a no-op — does not write project/state localStorage", () => {
    saveAppState({
      projects: {},
      activeProjectId: "none",
      servers: {},
      selectedServer: "none",
      selectedMultipleServers: [],
      isMultiSelectMode: false,
    });

    expect(localStorage.getItem("mcp-inspector-state")).toBeNull();
    expect(localStorage.getItem("mcp-inspector-projects")).toBeNull();
  });
});
