import { describe, expect, it } from "vitest";
import type { ServerWithName } from "@/hooks/use-app-state";
import { selectConnectedActiveServerNames } from "../use-playground-state";

function server(
  name: string,
  connectionStatus: ServerWithName["connectionStatus"]
): ServerWithName {
  return {
    name,
    config: { url: "https://example.invalid/mcp" } as ServerWithName["config"],
    connectionStatus,
    retryCount: 0,
  } as ServerWithName;
}

describe("selectConnectedActiveServerNames", () => {
  describe("multi-server (Playground)", () => {
    it("keeps servers whose connectionStatus is connected or connecting", () => {
      const result = selectConnectedActiveServerNames({
        selectedServerNames: ["bart", "foo", "baz", "qux"],
        serverName: undefined,
        servers: {
          bart: server("bart", "connected"),
          foo: server("foo", "disconnected"),
          baz: server("baz", "connecting"),
          qux: server("qux", "oauth-flow"),
        },
      });
      expect(result).toEqual(["bart", "baz"]);
    });

    it("preserves the input order of the connected subset", () => {
      const result = selectConnectedActiveServerNames({
        selectedServerNames: ["c", "a", "b"],
        serverName: undefined,
        servers: {
          a: server("a", "connected"),
          b: server("b", "connected"),
          c: server("c", "connected"),
        },
      });
      expect(result).toEqual(["c", "a", "b"]);
    });

    it("treats a server missing from the map as not connected", () => {
      // Regression guard: stale `selectedServerNames` referencing a server
      // the user deleted must not crash and must not flow through.
      const result = selectConnectedActiveServerNames({
        selectedServerNames: ["bart", "ghost"],
        serverName: undefined,
        servers: { bart: server("bart", "connected") },
      });
      expect(result).toEqual(["bart"]);
    });

    it("returns an empty list when none of the selected servers are connected", () => {
      const result = selectConnectedActiveServerNames({
        selectedServerNames: ["bart", "foo"],
        serverName: undefined,
        servers: {
          bart: server("bart", "disconnected"),
          foo: server("foo", "failed"),
        },
      });
      expect(result).toEqual([]);
    });
  });

  describe("single-server (App Builder fallback)", () => {
    it("returns the serverName when it is connected", () => {
      const result = selectConnectedActiveServerNames({
        selectedServerNames: undefined,
        serverName: "bart",
        servers: { bart: server("bart", "connected") },
      });
      expect(result).toEqual(["bart"]);
    });

    it("returns the serverName while it is connecting", () => {
      const result = selectConnectedActiveServerNames({
        selectedServerNames: undefined,
        serverName: "bart",
        servers: { bart: server("bart", "connecting") },
      });
      expect(result).toEqual(["bart"]);
    });

    it("returns an empty list when the serverName is disconnected", () => {
      // The exact bug from the screenshots: previously this branch returned
      // [serverName] regardless of status, so the Tools pane queried tools
      // for a server the user had toggled off.
      const result = selectConnectedActiveServerNames({
        selectedServerNames: undefined,
        serverName: "bart",
        servers: { bart: server("bart", "disconnected") },
      });
      expect(result).toEqual([]);
    });

    it("returns an empty list when serverName is missing from the map", () => {
      const result = selectConnectedActiveServerNames({
        selectedServerNames: undefined,
        serverName: "ghost",
        servers: {},
      });
      expect(result).toEqual([]);
    });

    it("returns an empty list when serverName is undefined", () => {
      const result = selectConnectedActiveServerNames({
        selectedServerNames: undefined,
        serverName: undefined,
        servers: {},
      });
      expect(result).toEqual([]);
    });
  });

  describe("branch precedence", () => {
    it("uses the multi-server branch when selectedServerNames is non-empty", () => {
      // serverName is provided AND connected, but selectedServerNames takes
      // precedence — the App Builder fallback only applies when the multi
      // list is empty/undefined.
      const result = selectConnectedActiveServerNames({
        selectedServerNames: ["foo"],
        serverName: "bart",
        servers: {
          bart: server("bart", "connected"),
          foo: server("foo", "connected"),
        },
      });
      expect(result).toEqual(["foo"]);
    });

    it("falls back to serverName when selectedServerNames is empty", () => {
      const result = selectConnectedActiveServerNames({
        selectedServerNames: [],
        serverName: "bart",
        servers: { bart: server("bart", "connected") },
      });
      expect(result).toEqual(["bart"]);
    });
  });
});
