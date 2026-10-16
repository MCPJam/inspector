import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  authorizeLocalExecutionOperation,
  sendChatMessageOperation,
} from "@mcpjam/sdk/platform";
import {
  PLATFORM_CATALOG_OPERATIONS,
  runPlatformOperation,
} from "../src/tools/platformTools.js";
import type { PlatformToolContext } from "../src/server.js";

afterEach(() => vi.unstubAllGlobals());
function localTarget(harnessId: "claude-code" | "codex") {
  const target = {
    kind: "local-native",
    scope: "unattended",
    harnessId,
    machineId: "machine",
    workspaceGrantId: "workspace",
    runtimeId: "runtime",
    permissionProfile: "unrestricted",
    policyVersion: "policy",
    grantToken: "test-local-capability",
  } as const;
  let turns = 0;
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/projects"))
      return Response.json({ items: [{ id: "project", name: "Project" }] });
    if (String(url).endsWith("/local-execution-grants"))
      return Response.json({ target, expiresAt: "2026-10-17T00:00:00Z" });
    const body = JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).get("x-mcpjam-local-harness-grant")).toBe(
      target.grantToken
    );
    expect(body.executionTarget).not.toHaveProperty("grantToken");
    if (turns) expect(body.sessionId).toBe("session");
    turns += 1;
    return Response.json({
      sessionId: "session",
      turnId: `turn-${turns}`,
      projectId: "project",
      persisted: { outcome: "saved" },
      origin: "api",
      execution: {
        engine: `harness:${harnessId}`,
        venue: "local-native",
        runtimeVersion: "fixture-1",
        sessionId: "wire",
        turnId: `turn-${turns}`,
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { target, count: () => turns };
}

describe("platform MCP local execution", () => {
  it.each(["claude-code", "codex"] as const)(
    "carries the %s grant and session through two turns",
    async (harnessId) => {
      const { target, count } = localTarget(harnessId);
      const context: PlatformToolContext = {
        getBearerToken: async () => "verified-user-token",
        runtimeEnv: {
          PLATFORM_API_URL: "http://127.0.0.1:6274/api/v1",
          MCPJAM_APP_ORIGIN: "http://127.0.0.1:6274",
        },
      };
      expect(PLATFORM_CATALOG_OPERATIONS).toContain(
        authorizeLocalExecutionOperation
      );
      const authorized = await runPlatformOperation(
        context,
        authorizeLocalExecutionOperation,
        { project: "project", harnessId, allowUnattended: true }
      );
      expect(authorized).toMatchObject({ structuredContent: { target } });
      const first = await runPlatformOperation(
        context,
        sendChatMessageOperation,
        {
          project: "project",
          modelId: "openai/gpt-5.5",
          environmentId: "environment",
          toolMode: "auto",
          message: "first",
          idempotencyKey: "first",
          executionTarget: target,
        }
      );
      const firstReply = z
        .object({ structuredContent: z.object({ sessionId: z.string() }) })
        .parse(first);
      const second = await runPlatformOperation(
        context,
        sendChatMessageOperation,
        {
          sessionId: firstReply.structuredContent.sessionId,
          message: "second",
          idempotencyKey: "second",
          executionTarget: target,
        }
      );
      expect(second).toMatchObject({
        structuredContent: {
          execution: {
            engine: `harness:${harnessId}`,
            venue: "local-native",
            turnId: "turn-2",
          },
        },
      });
      expect(count()).toBe(2);
    }
  );
});
