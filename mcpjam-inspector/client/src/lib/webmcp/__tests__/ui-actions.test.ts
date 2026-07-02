import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorCommand } from "@/shared/inspector-command.js";

const { executeInspectorCommandMock } = vi.hoisted(() => ({
  executeInspectorCommandMock: vi.fn(),
}));

vi.mock("@/lib/inspector-command-handlers", () => ({
  executeInspectorCommand: executeInspectorCommandMock,
}));

import {
  dispatchInspectorCommand,
  listUiNavigationTargets,
  navigateAction,
  resolveUiNavigationTarget,
  selectServerAction,
} from "../ui-actions";

describe("ui-actions (local mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeInspectorCommandMock.mockImplementation(
      async (command: InspectorCommand) => ({
        id: command.id,
        status: "success" as const,
        result: { echoed: command.type },
      }),
    );
  });

  describe("resolveUiNavigationTarget", () => {
    it("resolves known tabs and deep paths", () => {
      expect(resolveUiNavigationTarget("playground")).toEqual({
        ok: true,
        path: "/playground",
        tab: "playground",
      });
      expect(resolveUiNavigationTarget("evals/suite/abc")).toEqual({
        ok: true,
        path: "/evals/suite/abc",
        tab: "evals",
      });
      // Legacy alias: chat normalizes to playground.
      expect(resolveUiNavigationTarget("chat")).toMatchObject({
        ok: true,
        path: "/playground",
      });
      // Local mode: hosted-blocked tabs are valid.
      expect(resolveUiNavigationTarget("tracing")).toMatchObject({ ok: true });
    });

    it("rejects unknown and empty targets with the valid-target list", () => {
      const unknown = resolveUiNavigationTarget("bogus-page");
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) {
        expect(unknown.reason).toContain('Unknown navigation target "bogus-page"');
        expect(unknown.reason).toContain("playground");
      }
      expect(resolveUiNavigationTarget("   ")).toMatchObject({ ok: false });
    });
  });

  it("listUiNavigationTargets includes hosted-blocked tabs locally", () => {
    const targets = listUiNavigationTargets();
    for (const tab of ["tracing", "skills", "tasks", "auth", "playground"]) {
      expect(targets).toContain(tab);
    }
  });

  describe("navigateAction", () => {
    it("dispatches the resolved path through the command bus", async () => {
      const result = await navigateAction("playground");
      expect(result).toEqual({ ok: true, data: { echoed: "navigate" } });
      expect(executeInspectorCommandMock).toHaveBeenCalledTimes(1);
      const command = executeInspectorCommandMock.mock.calls[0][0];
      expect(command).toMatchObject({
        type: "navigate",
        payload: { target: "/playground" },
      });
      expect(typeof command.id).toBe("string");
    });

    it("rejects invalid targets without dispatching", async () => {
      const result = await navigateAction("bogus-page");
      expect(result.ok).toBe(false);
      expect(executeInspectorCommandMock).not.toHaveBeenCalled();
    });
  });

  it("selectServerAction maps command errors into the action result", async () => {
    executeInspectorCommandMock.mockResolvedValueOnce({
      id: "x",
      status: "error",
      error: { code: "unknown_server", message: 'Unknown server "nope".' },
    });
    const result = await selectServerAction("nope");
    expect(result).toEqual({
      ok: false,
      error: 'unknown_server: Unknown server "nope".',
    });
  });

  it("dispatchInspectorCommand times out wedged handlers", async () => {
    executeInspectorCommandMock.mockImplementation(
      () => new Promise(() => {}),
    );
    const response = await dispatchInspectorCommand({
      type: "navigate",
      payload: { target: "/servers" },
      timeoutMs: 25,
    });
    expect(response.status).toBe("error");
    if (response.status === "error") {
      expect(response.error.code).toBe("timeout");
      // The bus has no cancellation contract, so the handler may still
      // complete after we give up — the message must steer the model away
      // from blind retries (duplicate side effects).
      expect(response.error.message).toContain("may still complete");
    }
  });
});
