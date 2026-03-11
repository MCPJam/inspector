import { describe, it, expect } from "vitest";
import {
  buildMcpLifecycleScenario20250326,
  type McpTransport,
} from "../mcp-lifecycle-data";

describe("buildMcpLifecycleScenario20250326", () => {
  describe("stdio transport", () => {
    const scenario = buildMcpLifecycleScenario20250326({
      transport: "stdio",
    });

    it("has 3 actors: client, server, process", () => {
      expect(scenario.actors).toHaveLength(3);
      const ids = scenario.actors.map((a) => a.id);
      expect(ids).toEqual(["client", "server", "process"]);
    });

    it("has 7 actions (5 shared + 2 shutdown)", () => {
      expect(scenario.actions).toHaveLength(7);
    });

    it("actions are in the correct lifecycle order", () => {
      const ids = scenario.actions.map((a) => a.id);
      expect(ids).toEqual([
        "initialize_request",
        "initialize_result",
        "initialized_notification",
        "operation_request",
        "operation_response",
        "close_stdin",
        "process_exit",
      ]);
    });

    it("all action from/to reference valid actor ids", () => {
      const actorIds = new Set(scenario.actors.map((a) => a.id));
      for (const action of scenario.actions) {
        expect(actorIds.has(action.from)).toBe(true);
        expect(actorIds.has(action.to)).toBe(true);
      }
    });

    it("shutdown actions involve the process actor", () => {
      const closeStdin = scenario.actions.find(
        (a) => a.id === "close_stdin",
      );
      const processExit = scenario.actions.find(
        (a) => a.id === "process_exit",
      );

      expect(closeStdin?.from).toBe("client");
      expect(closeStdin?.to).toBe("process");
      expect(processExit?.from).toBe("process");
      expect(processExit?.to).toBe("client");
    });

    it("SIGTERM/SIGKILL is annotated on close_stdin details, not a separate step", () => {
      const closeStdin = scenario.actions.find(
        (a) => a.id === "close_stdin",
      );
      expect(closeStdin?.details).toBeDefined();
      const fallbackDetail = closeStdin?.details?.find(
        (d) => d.label === "Fallback",
      );
      expect(fallbackDetail).toBeDefined();
      expect(String(fallbackDetail?.value)).toMatch(/SIGTERM/);
      expect(String(fallbackDetail?.value)).toMatch(/SIGKILL/);
    });
  });

  describe("http transport", () => {
    const scenario = buildMcpLifecycleScenario20250326({
      transport: "http",
    });

    it("has 2 actors: client, server", () => {
      expect(scenario.actors).toHaveLength(2);
      const ids = scenario.actors.map((a) => a.id);
      expect(ids).toEqual(["client", "server"]);
    });

    it("has 5 actions (shared only, no shutdown steps)", () => {
      expect(scenario.actions).toHaveLength(5);
    });

    it("does NOT include process actor", () => {
      const ids = scenario.actors.map((a) => a.id);
      expect(ids).not.toContain("process");
    });

    it("does NOT include close_stdin or process_exit actions", () => {
      const ids = scenario.actions.map((a) => a.id);
      expect(ids).not.toContain("close_stdin");
      expect(ids).not.toContain("process_exit");
    });

    it("annotates shutdown info on operation_response", () => {
      const opResponse = scenario.actions.find(
        (a) => a.id === "operation_response",
      );
      expect(opResponse?.details).toBeDefined();
      const shutdownDetail = opResponse?.details?.find(
        (d) => d.label === "Shutdown",
      );
      expect(shutdownDetail).toBeDefined();
      expect(String(shutdownDetail?.value)).toMatch(/HTTP/i);
    });
  });

  describe("custom labels", () => {
    it("overrides labels when provided", () => {
      const scenario = buildMcpLifecycleScenario20250326({
        transport: "stdio",
        labels: {
          initialize_request: "Custom Init",
        },
      });

      const initAction = scenario.actions.find(
        (a) => a.id === "initialize_request",
      );
      expect(initAction?.label).toBe("Custom Init");
    });

    it("uses defaults for labels not provided", () => {
      const scenario = buildMcpLifecycleScenario20250326({
        transport: "stdio",
        labels: {
          initialize_request: "Custom Init",
        },
      });

      const initResult = scenario.actions.find(
        (a) => a.id === "initialize_result",
      );
      expect(initResult?.label).toBe("initialize (result)");
    });
  });

  describe("shared actions", () => {
    const transports: McpTransport[] = ["stdio", "http"];

    it.each(transports)(
      "first 5 actions are identical for %s transport",
      (transport) => {
        const scenario = buildMcpLifecycleScenario20250326({ transport });
        const first5Ids = scenario.actions.slice(0, 5).map((a) => a.id);
        expect(first5Ids).toEqual([
          "initialize_request",
          "initialize_result",
          "initialized_notification",
          "operation_request",
          "operation_response",
        ]);
      },
    );

    it("initialized_notification has the 'no requests before' note", () => {
      const scenario = buildMcpLifecycleScenario20250326({
        transport: "stdio",
      });
      const initialized = scenario.actions.find(
        (a) => a.id === "initialized_notification",
      );
      const noteDetail = initialized?.details?.find(
        (d) => d.label === "Note",
      );
      expect(String(noteDetail?.value)).toMatch(/No requests.*before/i);
    });

    it("initialize_request includes version negotiation note", () => {
      const scenario = buildMcpLifecycleScenario20250326({
        transport: "stdio",
      });
      const initReq = scenario.actions.find(
        (a) => a.id === "initialize_request",
      );
      const noteDetail = initReq?.details?.find((d) => d.label === "Note");
      expect(String(noteDetail?.value)).toMatch(/[Vv]ersion/);
    });
  });
});
